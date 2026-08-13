// Path: test/ssh-key.test.ts
// `resolveSshKey` (final-review fix wave item 3): tilde expansion, missing-
// file throw, present-file passthrough. All against real tmp files/dirs —
// no mocking of `node:fs`/`node:os`, since the whole point is to prove the
// preflight talks to the real filesystem.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSshKey } from '../src/ssh-key.js';

describe('resolveSshKey', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'znvault-plugin-vsphere-ssh-key-'));
    originalHome = process.env.HOME;
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('expands a leading ~ to os.homedir() and resolves when the file exists there', () => {
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, '.ssh'), { recursive: true });
    const keyPath = join(tmpDir, '.ssh', 'id_ed25519');
    writeFileSync(keyPath, 'fake-private-key');

    const resolved = resolveSshKey('~/.ssh/id_ed25519');

    expect(resolved).toBe(keyPath);
  });

  it('throws a clear "SSH key not found: <expanded path>" error when the file is missing', () => {
    process.env.HOME = tmpDir;
    const expected = join(tmpDir, '.ssh', 'does-not-exist');

    expect(() => resolveSshKey('~/.ssh/does-not-exist')).toThrow(
      `SSH key not found: ${expected}`,
    );
  });

  it('passes through an absolute path unchanged (present file) and returns it verbatim', () => {
    const keyPath = join(tmpDir, 'custom-key');
    writeFileSync(keyPath, 'fake-private-key');

    const resolved = resolveSshKey(keyPath);

    expect(resolved).toBe(keyPath);
  });

  it('throws for a missing absolute path, naming that exact path (no tilde involved)', () => {
    const missing = join(tmpDir, 'no-such-key');

    expect(() => resolveSshKey(missing)).toThrow(`SSH key not found: ${missing}`);
  });
});
