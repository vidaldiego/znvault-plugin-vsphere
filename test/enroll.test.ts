// Path: test/enroll.test.ts
// `requestToken`/`enrollScript`/`redactToken`/`sshRun` (pure builders) and
// the `runEnroll` handler (guard + sequential steps + token hygiene +
// first-failure-stops + --retry-bootstrap), driven entirely by fake
// `RunFn`/client — no real ssh/vCenter/vault is ever invoked.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFn, RunResult } from '../src/run.js';
import {
  requestToken,
  enrollScript,
  redactToken,
  sshRun,
  runEnroll,
  type EnrollOpts,
  type BootstrapTokenResponse,
  type EnrollCommandOptions,
} from '../src/enroll.js';

// `runEnroll` now runs an SSH-key existence preflight (final-review fix wave
// item 3) unconditionally, including on the default `--ssh-key`
// (`~/.ssh/id_ed25519`, see `enroll.ts`'s `DEFAULT_SSH_KEY`). None of the
// `runEnroll` tests below are about that preflight (see the dedicated
// `resolveSshKey` coverage in `test/ssh-key.test.ts` and the handler-level
// test in the `runEnroll` describe block) — they exercise everything AFTER
// it — so `$HOME` is pointed at a tmp dir with a real `.ssh/id_ed25519` for
// the whole file, letting the untouched default resolve without every test
// needing its own `--ssh-key` override.
let sshKeyHomeDir: string;
let originalHome: string | undefined;

beforeAll(() => {
  sshKeyHomeDir = mkdtempSync(join(tmpdir(), 'znvault-plugin-vsphere-enroll-test-'));
  mkdirSync(join(sshKeyHomeDir, '.ssh'), { recursive: true });
  writeFileSync(join(sshKeyHomeDir, '.ssh', 'id_ed25519'), 'fake-private-key');
  originalHome = process.env.HOME;
  process.env.HOME = sshKeyHomeDir;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sshKeyHomeDir, { recursive: true, force: true });
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

const RAW_TOKEN = 'zrt_abcdefgh12345678superSecretTail';

const tokenResponse: BootstrapTokenResponse = {
  token: RAW_TOKEN,
  expiresAt: '2026-08-13T05:00:00.000Z',
  bootstrapUrl: 'https://vault.zincapp.com/agent/bootstrap',
  hostConfigId: 'hcfg_c01c348b55f04b88',
  hostname: 'trust-api-1',
  agentHostname: 'trust-api-1',
};

// --- requestToken ------------------------------------------------------

describe('requestToken', () => {
  it('POSTs the exact path and body (expiresInSeconds, never expiresAt) and resolves the response', async () => {
    let seenPath: string | undefined;
    let seenBody: unknown;
    const client = {
      post: async <T>(path: string, body: unknown): Promise<T> => {
        seenPath = path;
        seenBody = body;
        return tokenResponse as unknown as T;
      },
    };

    const result = await requestToken(client, 'trust-fleet', 'trust-api-1');

    expect(seenPath).toBe('/v1/hosts/trust-fleet/bootstrap-token');
    expect(seenBody).toEqual({ agentHostname: 'trust-api-1', expiresInSeconds: 3600 });
    expect(seenBody).not.toHaveProperty('expiresAt');
    expect(result).toEqual(tokenResponse);
  });
});

// --- enrollScript --------------------------------------------------------

describe('enrollScript', () => {
  const vaultUrl = 'https://vault.zincapp.com';
  const hostname = 'trust-api-1';

  it('returns exactly 8 steps in the runbook order, with the token embedded ONLY in step 4 (login)', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname, '1.20.17');

    expect(steps).toHaveLength(8);

    const stepsContainingToken = steps.filter((s) => s.includes(RAW_TOKEN));
    expect(stepsContainingToken).toHaveLength(1);
    expect(steps[3]).toContain(RAW_TOKEN);

    // Sanity: every other step is token-free.
    for (const [i, step] of steps.entries()) {
      if (i === 3) continue;
      expect(step).not.toContain(RAW_TOKEN);
    }
  });

  it('step 1 installs the pinned version; falls back to @latest when no version is given', () => {
    expect(enrollScript(vaultUrl, RAW_TOKEN, hostname, '1.20.17')[0]).toBe(
      'sudo npm install -g @zincapp/zn-vault-agent@1.20.17',
    );
    expect(enrollScript(vaultUrl, RAW_TOKEN, hostname)[0]).toBe('sudo npm install -g @zincapp/zn-vault-agent@latest');
  });

  it('step 2 (symlink gotcha) fixes both /usr/bin and /usr/local/bin and verifies --version — BEFORE step 3 (setup)', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname);
    expect(steps[1]).toContain('ln -sf');
    expect(steps[1]).toContain('/usr/bin/zn-vault-agent');
    expect(steps[1]).toContain('/usr/local/bin/zn-vault-agent');
    expect(steps[1]).toContain('zn-vault-agent --version');
    expect(steps[2]).toBe('sudo zn-vault-agent setup -y');

    // Order matters: symlink fix (index 1) must run before setup (index 2).
    const symlinkIndex = steps.findIndex((s) => s.includes('ln -sf'));
    const setupIndex = steps.findIndex((s) => s === 'sudo zn-vault-agent setup -y');
    expect(symlinkIndex).toBeLessThan(setupIndex);
  });

  it('step 4 (login) carries --url/--bootstrap-token/--host-name', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname);
    expect(steps[3]).toBe(
      `sudo zn-vault-agent login --url ${vaultUrl} --bootstrap-token ${RAW_TOKEN} --host-name ${hostname}`,
    );
  });

  it('step 5 (ownership gotcha) chowns both /etc and /var/lib config dirs to zn-vault-agent', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname);
    expect(steps[4]).toBe('sudo chown -R zn-vault-agent:zn-vault-agent /etc/zn-vault-agent /var/lib/zn-vault-agent');
  });

  it('step 6 (RuntimeDirectory gotcha) writes the systemd drop-in and reloads', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname);
    expect(steps[5]).toContain('RuntimeDirectory=zn-vault-agent');
    expect(steps[5]).toContain('/etc/systemd/system/zn-vault-agent.service.d/runtime-dir.conf');
    expect(steps[5]).toContain('systemctl daemon-reload');
  });

  it('step 7 restarts the service; step 8 verifies is-active + curl /health', () => {
    const steps = enrollScript(vaultUrl, RAW_TOKEN, hostname);
    expect(steps[6]).toBe('sudo systemctl restart zn-vault-agent');
    expect(steps[7]).toBe('sudo systemctl is-active zn-vault-agent && curl -sf http://localhost:9100/health');
  });
});

// --- redactToken -----------------------------------------------------------

describe('redactToken', () => {
  it('reduces a zrt_ token to the prefix + first 8 chars + ellipsis, never the full token', () => {
    const redacted = redactToken(RAW_TOKEN);
    expect(redacted).toBe('zrt_abcdefgh…');
    expect(redacted).not.toBe(RAW_TOKEN);
    // The redacted form must not leak the token's secret tail.
    expect(redacted).not.toContain('superSecretTail');
  });
});

// --- sshRun ------------------------------------------------------------

describe('sshRun', () => {
  it('shells out via the standard ssh flags against opts.ip/sshUser/sshKey', async () => {
    const seen: string[][] = [];
    const run: RunFn = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return ok();
    };
    const opts: EnrollOpts = {
      fleet: 'trust-fleet',
      hostname: 'trust-api-1',
      ip: '172.16.211.30',
      sshUser: 'sysadmin',
      sshKey: '/home/x/.ssh/id_ed25519',
    };

    await sshRun(run, opts, 'echo hi');

    expect(seen).toEqual([
      ['ssh', '-o', 'StrictHostKeyChecking=no', '-i', opts.sshKey, `${opts.sshUser}@${opts.ip}`, 'echo hi'],
    ]);
  });
});

// --- runEnroll handler ---------------------------------------------------

function fakeCtx() {
  const info: string[] = [];
  const error: string[] = [];
  const success: string[] = [];
  const warn: string[] = [];
  return {
    ctx: {
      client: { get: async () => ({}) as never, post: async <T>() => tokenResponse as unknown as T },
      output: {
        success: (m: string) => success.push(m),
        error: (m: string) => error.push(m),
        warn: (m: string) => warn.push(m),
        info: (m: string) => info.push(m),
      },
      getConfig: () => ({ url: 'https://vault.zincapp.com' }),
      isPlainMode: () => true,
    },
    info,
    error,
    success,
    warn,
  };
}

const baseOpts: EnrollCommandOptions = {
  fleet: 'trust-fleet',
  name: 'trust-api-1',
  ip: '172.16.211.30',
};

/** Every ssh call (any command) succeeds with empty stdout, except the final verification step, which echoes a health payload. */
function fakeRunAllGreen(): RunFn {
  let call = 0;
  return async (cmd, args) => {
    if (cmd !== 'ssh') throw new Error(`unexpected non-ssh call: ${cmd} ${args.join(' ')}`);
    call += 1;
    const command = args.at(-1) ?? '';
    if (command.includes('curl -sf')) {
      return ok('{"status":"ok"}');
    }
    return ok(`step-${call}-stdout`);
  };
}

describe('runEnroll', () => {
  it('requests a token, then runs all 8 steps over ssh in order, and exits 0', async () => {
    const { ctx, success, error } = fakeCtx();
    const seenCommands: string[] = [];
    const run: RunFn = async (cmd, args) => {
      seenCommands.push(args.at(-1) ?? '');
      return fakeRunAllGreen()(cmd, args);
    };

    const code = await runEnroll(ctx as never, baseOpts, run);

    expect(error).toEqual([]);
    expect(code).toBe(0);
    expect(seenCommands).toHaveLength(8);
    expect(seenCommands[0]).toContain('npm install -g @zincapp/zn-vault-agent@latest');
    expect(seenCommands[3]).toContain('sudo zn-vault-agent login');
    expect(seenCommands[7]).toContain('curl -sf');
    expect(success.some((l) => l.includes('enrolled on trust-api-1'))).toBe(true);
  });

  it('echoes the final verification step\'s stdout on success', async () => {
    const { ctx, info } = fakeCtx();
    const code = await runEnroll(ctx as never, baseOpts, fakeRunAllGreen());

    expect(code).toBe(0);
    expect(info.some((l) => l.includes('{"status":"ok"}'))).toBe(true);
  });

  it('token hygiene: no output line ever contains the full raw token, only the redacted form', async () => {
    const { ctx, info, success, error, warn } = fakeCtx();

    const code = await runEnroll(ctx as never, baseOpts, fakeRunAllGreen());

    expect(code).toBe(0);
    const allLoggedText = [...info, ...success, ...error, ...warn].join('\n');
    expect(allLoggedText).not.toContain(RAW_TOKEN);
    expect(allLoggedText).toContain(redactToken(RAW_TOKEN));
  });

  it('stops at the first failing step: reports its label + stderr, exits 1, and never calls later steps', async () => {
    const { ctx, error } = fakeCtx();
    const seenCommands: string[] = [];
    const run: RunFn = async (cmd, args) => {
      const command = args.at(-1) ?? '';
      seenCommands.push(command);
      if (command.includes('zn-vault-agent setup -y')) {
        return { code: 1, stdout: '', stderr: 'setup: permission denied' };
      }
      return ok();
    };

    const code = await runEnroll(ctx as never, baseOpts, run);

    expect(code).toBe(1);
    // Steps 1 and 2 ran (install, symlink), step 3 (setup) failed, steps 4-8 never ran.
    expect(seenCommands).toHaveLength(3);
    expect(error.some((l) => l.includes('setup agent infra') && l.includes('setup: permission denied'))).toBe(true);
  });

  it('a failure on step 4 (login) never leaks the full token in the error line', async () => {
    const { ctx, error } = fakeCtx();
    const run: RunFn = async (_cmd, args) => {
      const command = args.at(-1) ?? '';
      if (command.includes('zn-vault-agent login')) {
        return { code: 1, stdout: '', stderr: 'login: invalid token' };
      }
      return ok();
    };

    const code = await runEnroll(ctx as never, baseOpts, run);

    expect(code).toBe(1);
    const errorText = error.join('\n');
    expect(errorText).not.toContain(RAW_TOKEN);
    expect(errorText).toContain('login with bootstrap token');
  });

  it('token request failure stops before any ssh step runs', async () => {
    const { ctx, error } = fakeCtx();
    ctx.client.post = async () => {
      throw new Error('server unreachable');
    };
    let sshCalled = false;
    const run: RunFn = async () => {
      sshCalled = true;
      return ok();
    };

    const code = await runEnroll(ctx as never, baseOpts, run);

    expect(code).toBe(1);
    expect(sshCalled).toBe(false);
    expect(error.some((l) => l.includes('server unreachable'))).toBe(true);
  });

  describe('--retry-bootstrap', () => {
    it('re-runs the bootstrap command over ssh BEFORE requesting a token or running the 8 steps', async () => {
      const { ctx } = fakeCtx();
      const seenCommands: string[] = [];
      let tokenRequested = false;
      ctx.client.post = async <T>(): Promise<T> => {
        tokenRequested = true;
        return tokenResponse as unknown as T;
      };
      const run: RunFn = async (cmd, args) => {
        seenCommands.push(args.at(-1) ?? '');
        return ok();
      };

      const code = await runEnroll(ctx as never, { ...baseOpts, retryBootstrap: true }, run);

      expect(code).toBe(0);
      // First command must be the bootstrap-vm install line, not the agent npm install.
      expect(seenCommands[0]).toContain('bootstrap-vm/main/install.sh');
      expect(seenCommands[0]).toContain('--hostname trust-api-1');
      expect(tokenRequested).toBe(true);
      // Bootstrap retry (1) + the 8 enroll steps = 9 ssh calls total.
      expect(seenCommands).toHaveLength(9);
    });

    it('a failed bootstrap retry stops before requesting a token', async () => {
      const { ctx, error } = fakeCtx();
      let tokenRequested = false;
      ctx.client.post = async <T>(): Promise<T> => {
        tokenRequested = true;
        return tokenResponse as unknown as T;
      };
      const run: RunFn = async () => ({ code: 1, stdout: '', stderr: 'no route to host' });

      const code = await runEnroll(ctx as never, { ...baseOpts, retryBootstrap: true }, run);

      expect(code).toBe(1);
      expect(tokenRequested).toBe(false);
      expect(error.some((l) => l.includes('Bootstrap retry failed') && l.includes('no route to host'))).toBe(true);
    });

    it('forwards static-ip/gateway/dns/skip-ca/bootstrap-args into the retried bootstrap command', async () => {
      const { ctx } = fakeCtx();
      const seenCommands: string[] = [];
      const run: RunFn = async (_cmd, args) => {
        seenCommands.push(args.at(-1) ?? '');
        return ok();
      };

      await runEnroll(
        ctx as never,
        {
          ...baseOpts,
          retryBootstrap: true,
          staticIp: '172.16.211.30/24',
          gateway: '172.16.211.1',
          dns: '172.16.50.250',
          skipSshCa: true,
          skipPkiCa: true,
          bootstrapArgs: '--extra flag',
        },
        run,
      );

      const bootstrapLine = seenCommands[0] ?? '';
      expect(bootstrapLine).toContain('--static-ip 172.16.211.30/24');
      expect(bootstrapLine).toContain('--gateway 172.16.211.1');
      expect(bootstrapLine).toContain('--dns "172.16.50.250"');
      expect(bootstrapLine).toContain('--no-ssh-ca');
      expect(bootstrapLine).toContain('--no-pki-ca');
      expect(bootstrapLine).toContain('--extra flag');
    });
  });

  it('uses default sshUser/sshKey (sysadmin / ~/.ssh/id_ed25519) when not overridden', async () => {
    const { ctx } = fakeCtx();
    const seenTargets: string[] = [];
    const run: RunFn = async (_cmd, args) => {
      seenTargets.push(args[4] ?? ''); // user@ip
      return ok();
    };

    await runEnroll(ctx as never, baseOpts, run);

    expect(seenTargets.every((t) => t === 'sysadmin@172.16.211.30')).toBe(true);
  });

  it('honors explicit --ssh-user/--ssh-key overrides', async () => {
    const { ctx } = fakeCtx();
    // Must be a real file: `runEnroll`'s SSH-key preflight (item 3) now
    // statSyncs this path before running any step.
    const customKey = join(sshKeyHomeDir, 'custom-key');
    writeFileSync(customKey, 'fake-private-key');
    const seenKeys: string[] = [];
    const seenTargets: string[] = [];
    const run: RunFn = async (_cmd, args) => {
      seenKeys.push(args[3] ?? '');
      seenTargets.push(args[4] ?? '');
      return ok();
    };

    await runEnroll(ctx as never, { ...baseOpts, sshUser: 'ops', sshKey: customKey }, run);

    expect(seenKeys.every((k) => k === customKey)).toBe(true);
    expect(seenTargets.every((t) => t === 'ops@172.16.211.30')).toBe(true);
  });

  it(
    'a missing --ssh-key exits 1 with a clear message before requesting a token or running any ssh step',
    async () => {
      const { ctx, error } = fakeCtx();
      const missingKey = join(sshKeyHomeDir, 'does-not-exist-key');
      let tokenRequested = false;
      ctx.client.post = async <T>(): Promise<T> => {
        tokenRequested = true;
        return tokenResponse as unknown as T;
      };
      let runCalled = false;
      const run: RunFn = async () => {
        runCalled = true;
        return ok();
      };

      const code = await runEnroll(ctx as never, { ...baseOpts, sshKey: missingKey }, run);

      expect(code).toBe(1);
      expect(tokenRequested).toBe(false);
      expect(runCalled).toBe(false);
      expect(error).toEqual([`SSH key not found: ${missingKey}`]);
    },
  );
});
