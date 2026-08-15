import { describe, expect, it } from 'vitest';
import type { CLIPluginContext } from '../src/plugin-types.js';
import type { RunFn } from '../src/run.js';
import {
  bindGovcCredential,
  DEFAULT_VCENTER_CREDENTIAL_ALIAS,
  readVcenterCredential,
} from '../src/vault-credentials.js';

const metadata = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  alias: DEFAULT_VCENTER_CREDENTIAL_ALIAS,
  type: 'credential',
};

const decrypted = {
  ...metadata,
  data: {
    url: 'https://172.16.51.51',
    username: 'sentinel-dr-fence',
    password: 'test-only-password',
    insecure: true,
  },
};

function context(overrides?: { metadata?: unknown; decrypted?: unknown }): CLIPluginContext {
  return {
    client: {
      get: async () => (overrides?.metadata ?? metadata) as never,
      post: async () => (overrides?.decrypted ?? decrypted) as never,
    },
    output: { success() {}, error() {}, warn() {}, info() {} },
    getConfig: () => ({ url: 'https://vault.test' }),
    isPlainMode: () => true,
  };
}

describe('readVcenterCredential', () => {
  it('resolves metadata then decrypts the exact tenant-scoped alias', async () => {
    const calls: Array<[string, string]> = [];
    const ctx = context();
    ctx.client.get = async (path) => {
      calls.push(['GET', path]);
      return metadata as never;
    };
    ctx.client.post = async (path) => {
      calls.push(['POST', path]);
      return decrypted as never;
    };

    const value = await readVcenterCredential(ctx);

    expect(value).toEqual({
      alias: DEFAULT_VCENTER_CREDENTIAL_ALIAS,
      url: 'https://172.16.51.51',
      username: 'sentinel-dr-fence',
      password: 'test-only-password',
      insecure: true,
    });
    expect(calls).toEqual([
      ['GET', `/v1/secrets/alias/${encodeURIComponent(DEFAULT_VCENTER_CREDENTIAL_ALIAS)}`],
      ['POST', `/v1/secrets/${metadata.id}/decrypt?resolve=false`],
    ]);
  });

  it('rejects identity substitution between metadata and decrypt', async () => {
    const changed = { ...decrypted, alias: 'infra/vsphere/other' };
    await expect(readVcenterCredential(context({ decrypted: changed }))).rejects.toThrow(
      /changed while resolving/,
    );
  });

  it('rejects a URL containing embedded credentials', async () => {
    const changed = {
      ...decrypted,
      data: { ...decrypted.data, url: 'https://user:password@172.16.51.51' },
    };
    await expect(readVcenterCredential(context({ decrypted: changed }))).rejects.toThrow(
      /HTTPS URL without credentials/,
    );
  });

  it('does not include a rejected password in its error', async () => {
    const changed = { ...decrypted, data: { ...decrypted.data, password: '' } };
    const error = await readVcenterCredential(context({ decrypted: changed })).catch(
      (reason: unknown) => reason,
    );
    expect(String(error)).not.toContain('test-only-password');
  });
});

describe('bindGovcCredential', () => {
  it('injects GOVC values only into govc and never mutates process.env', async () => {
    const calls: Array<{ cmd: string; env: Record<string, string> | undefined }> = [];
    const run: RunFn = async (cmd, _args, opts) => {
      calls.push({ cmd, env: opts?.env });
      return { code: 0, stdout: '', stderr: '' };
    };
    const before = process.env.GOVC_PASSWORD;
    const bound = bindGovcCredential(run, {
      alias: DEFAULT_VCENTER_CREDENTIAL_ALIAS,
      url: 'https://172.16.51.51',
      username: 'sentinel-dr-fence',
      password: 'test-only-password',
      insecure: false,
    });

    await bound('govc', ['about']);
    await bound('ssh', ['host', 'true']);

    expect(calls[0]?.env).toEqual({
      GOVC_URL: 'https://172.16.51.51',
      GOVC_USERNAME: 'sentinel-dr-fence',
      GOVC_PASSWORD: 'test-only-password',
      GOVC_INSECURE: '0',
    });
    expect(calls[1]?.env).toBeUndefined();
    expect(process.env.GOVC_PASSWORD).toBe(before);
  });
});
