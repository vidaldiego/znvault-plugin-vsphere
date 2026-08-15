import { describe, it, expect, afterEach } from 'vitest';
import { execRun, makeDryRun } from '../src/run.js';

describe('makeDryRun', () => {
  it('collects a `[dry-run] cmd args…` line per call and resolves with code 0', async () => {
    const lines: string[] = [];
    const run = makeDryRun((line) => lines.push(line));

    const result = await run('govc', ['vm.clone', '-vm', '/ZincApp/vm/tpl', 'trust-api-1']);

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(lines).toEqual(['[dry-run] govc vm.clone -vm /ZincApp/vm/tpl trust-api-1']);
  });

  it('never touches the filesystem/network — one logged line per invocation, in order', async () => {
    const lines: string[] = [];
    const run = makeDryRun((line) => lines.push(line));

    await run('govc', ['vm.power', '-on', '/ZincApp/vm/trust-api-1']);
    await run('ssh', ['sysadmin@192.0.2.5', 'echo ok']);

    expect(lines).toEqual([
      '[dry-run] govc vm.power -on /ZincApp/vm/trust-api-1',
      '[dry-run] ssh sysadmin@192.0.2.5 echo ok',
    ]);
  });
});

describe('execRun', () => {
  const originalTestValue = process.env.ZNVAULT_RUN_TEST_VALUE;

  afterEach(() => {
    if (originalTestValue === undefined) delete process.env.ZNVAULT_RUN_TEST_VALUE;
    else process.env.ZNVAULT_RUN_TEST_VALUE = originalTestValue;
  });

  it('resolves with stdout and code 0 on success', async () => {
    const result = await execRun(process.execPath, ['-e', "process.stdout.write('hello')"]);
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' });
  });

  it('resolves (does not reject) with the non-zero exit code and stderr on failure', async () => {
    const result = await execRun(process.execPath, [
      '-e',
      "process.stderr.write('boom'); process.exit(3)",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('resolves with code -1 and the error message in stderr on spawn failure', async () => {
    const result = await execRun('this-binary-does-not-exist-anywhere', []);
    expect(result.code).toBe(-1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('inherits process.env for ordinary child-process configuration', async () => {
    process.env.ZNVAULT_RUN_TEST_VALUE = 'inherited';
    const result = await execRun(process.execPath, [
      '-e',
      'process.stdout.write(process.env.ZNVAULT_RUN_TEST_VALUE || "")',
    ]);
    expect(result.stdout).toBe('inherited');
  });

  it('never invokes a shell — shell metacharacters in an arg are passed through literally', async () => {
    const result = await execRun(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$(echo pwned); rm -rf /',
    ]);
    expect(result.stdout).toBe('$(echo pwned); rm -rf /');
  });

  it(
    'captures output larger than execFile\'s default 1 MiB maxBuffer intact, with code 0 ' +
      '(pins the fix: the old default kills the child on overflow, which execRun would ' +
      'otherwise misreport as a spawn failure — code -1 — exactly like a missing binary; ' +
      'a real remote bootstrap transcript routinely exceeds 1 MiB)',
    async () => {
      const ONE_MIB = 1024 * 1024;
      const size = ONE_MIB + 512 * 1024; // 1.5 MiB — comfortably past the old 1 MiB default
      const result = await execRun(process.execPath, [
        '-e',
        `process.stdout.write('a'.repeat(${size}))`,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBe(size);
      expect(result.stdout).toBe('a'.repeat(size));
    },
  );
});
