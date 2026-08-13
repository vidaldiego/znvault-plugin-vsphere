// Path: test/create.test.ts
// `createPhases` (pure phase-list builder) and `create` handler tests
// (guard + dry-run + guarded execution + bootstrap-failure reporting),
// driven entirely by fake `RunFn`/`sleep` — no real govc/ssh/vCenter is
// ever invoked.

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFn, RunResult } from '../src/run.js';
import type { VmSpec } from '../src/vm-spec.js';
import { paths } from '../src/vm-spec.js';
import { createPhases, makeCreateDryRun } from '../src/create.js';
import { runCreate, type CreateOptions } from '../src/commands.js';
import type { runEnroll } from '../src/enroll.js';

// `runCreate` now runs an SSH-key existence preflight (final-review fix wave
// item 3) unconditionally, including on the default `--ssh-key`
// (`~/.ssh/id_ed25519`, see `commands.ts`'s `buildCreateVmSpec`). None of the
// `runCreate` tests below are about that preflight (see the dedicated
// `resolveSshKey` coverage in `test/ssh-key.test.ts` and the handler-level
// test near the bottom of this file) — they exercise everything AFTER it —
// so `$HOME` is pointed at a tmp dir with a real `.ssh/id_ed25519` for the
// whole file, letting the untouched default resolve without every test
// needing its own `--ssh-key` override.
let sshKeyHomeDir: string;
let originalHome: string | undefined;

beforeAll(() => {
  sshKeyHomeDir = mkdtempSync(join(tmpdir(), 'znvault-plugin-vsphere-create-test-'));
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

const baseSpec: VmSpec = {
  name: 'trust-api-1',
  template: 'ubuntu-template-base',
  datacenter: 'ZincApp',
  cluster: 'Primary',
  datastore: 'vsanDatastore',
  sshUser: 'sysadmin',
  sshKey: '/home/x/.ssh/id_ed25519',
  timeoutMinutes: 10,
};

const templatePath = '/ZincApp/vm/ubuntu-template-base';
const p = paths(baseSpec);

const noopSleep = async () => {};

function labelsOf(spec: VmSpec): string[] {
  return createPhases(spec, templatePath, undefined, { sleep: noopSleep }).map((ph) => ph.label);
}

describe('createPhases', () => {
  it('a full spec (cpu, ram, disk, network) produces clone/resize/grow-disk/network/power-on in order', () => {
    const spec: VmSpec = { ...baseSpec, numCpu: 4, memoryGb: 8, diskGb: 100, network: 'VM Network' };
    expect(labelsOf(spec)).toEqual(['clone', 'resize', 'grow-disk', 'network', 'power-on']);
  });

  it('a minimal spec (no cpu/ram/disk/network) produces only clone/power-on', () => {
    expect(labelsOf(baseSpec)).toEqual(['clone', 'power-on']);
  });

  it('includes resize when only numCpu is set, and also when only memoryGb is set', () => {
    expect(labelsOf({ ...baseSpec, numCpu: 2 })).toEqual(['clone', 'resize', 'power-on']);
    expect(labelsOf({ ...baseSpec, memoryGb: 4 })).toEqual(['clone', 'resize', 'power-on']);
  });

  describe('clone phase', () => {
    it('runs govc vm.clone with cloneArgs and settles via deps.sleep before returning', async () => {
      const seen: string[][] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      };
      const sleepCalls: number[] = [];
      const phases = createPhases(baseSpec, templatePath, undefined, {
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      await phases[0]!.exec(run);

      expect(seen[0]![0]).toBe('govc');
      expect(seen[0]![1]).toBe('vm.clone');
      expect(sleepCalls.length).toBe(1);
    });

    it('throws with vm.clone stderr when the clone fails', async () => {
      const run: RunFn = async () => ({ code: 1, stdout: '', stderr: 'no such template' });
      const phases = createPhases(baseSpec, templatePath, undefined, { sleep: noopSleep });

      await expect(phases[0]!.exec(run)).rejects.toThrow(/vm\.clone.*no such template/);
    });
  });

  describe('resize phase', () => {
    it('passes -c and -m (GB*1024) against the VM path', async () => {
      const spec: VmSpec = { ...baseSpec, numCpu: 4, memoryGb: 8 };
      const seen: string[][] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      };
      const resize = createPhases(spec, templatePath, undefined, { sleep: noopSleep }).find(
        (ph) => ph.label === 'resize',
      )!;

      await resize.exec(run);

      expect(seen).toEqual([['govc', 'vm.change', '-vm', p.vm, '-c', '4', '-m', '8192']]);
    });
  });

  describe('grow-disk phase', () => {
    const ONE_GB = 1_073_741_824;

    function growDiskPhase(spec: VmSpec, log?: (line: string) => void) {
      return createPhases(spec, templatePath, undefined, { sleep: noopSleep, log }).find(
        (ph) => ph.label === 'grow-disk',
      )!;
    }

    it('re-reads the CLONE (not the template) device.info and resizes its single disk when growing', async () => {
      const spec: VmSpec = { ...baseSpec, diskGb: 100 };
      const seen: string[][] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        if (args[0] === 'device.info') {
          return {
            code: 0,
            stdout: JSON.stringify({ devices: [{ key: 2001, capacityInBytes: 50 * ONE_GB }] }),
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      };

      await growDiskPhase(spec).exec(run);

      expect(seen[0]).toEqual(['govc', 'device.info', '-json', '-vm', p.vm, 'disk-*']);
      expect(seen[1]).toEqual(['govc', 'vm.disk.change', '-vm', p.vm, '-disk.key', '2001', '-size', '100G']);
    });

    it('skips vm.disk.change when the requested size equals the clone\'s current size, and logs why', async () => {
      const spec: VmSpec = { ...baseSpec, diskGb: 50 };
      const seen: string[][] = [];
      const logLines: string[] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        if (args[0] === 'device.info') {
          return {
            code: 0,
            stdout: JSON.stringify({ devices: [{ key: 2001, capacityInBytes: 50 * ONE_GB }] }),
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      };

      await growDiskPhase(spec, (line) => logLines.push(line)).exec(run);

      expect(seen.some((call) => call[1] === 'vm.disk.change')).toBe(false);
      expect(logLines.some((l) => l.includes('50GB') && /skip/i.test(l))).toBe(true);
    });

    it(
      "skips vm.disk.change when the requested size is smaller than the clone's current size " +
        '(strict-greater semantics, script line 437 — plan\'s precheck only guards the template, ' +
        'this re-read is the authoritative gate against the clone)',
      async () => {
        const spec: VmSpec = { ...baseSpec, diskGb: 40 };
        const seen: string[][] = [];
        const run: RunFn = async (cmd, args) => {
          seen.push([cmd, ...args]);
          if (args[0] === 'device.info') {
            return {
              code: 0,
              stdout: JSON.stringify({ devices: [{ key: 2001, capacityInBytes: 50 * ONE_GB }] }),
              stderr: '',
            };
          }
          return { code: 0, stdout: '', stderr: '' };
        };

        await growDiskPhase(spec).exec(run);

        expect(seen.some((call) => call[1] === 'vm.disk.change')).toBe(false);
      },
    );

    it('refuses an ambiguous resize when the clone has more than one disk', async () => {
      const spec: VmSpec = { ...baseSpec, diskGb: 100 };
      const run: RunFn = async (): Promise<RunResult> => ({
        code: 0,
        stdout: JSON.stringify({ devices: [{ key: 2000 }, { key: 2001 }] }),
        stderr: '',
      });

      await expect(growDiskPhase(spec).exec(run)).rejects.toThrow(
        'Cloned VM has 2 disks; refusing an ambiguous resize',
      );
    });

    it('refuses when the clone has zero disks', async () => {
      const spec: VmSpec = { ...baseSpec, diskGb: 100 };
      const run: RunFn = async (): Promise<RunResult> => ({
        code: 0,
        stdout: JSON.stringify({ devices: [] }),
        stderr: '',
      });

      await expect(growDiskPhase(spec).exec(run)).rejects.toThrow(
        'Cloned VM has 0 disks; refusing an ambiguous resize',
      );
    });

    it('fails closed when govc device.info exits non-zero', async () => {
      const spec: VmSpec = { ...baseSpec, diskGb: 100 };
      const run: RunFn = async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'no such vm' });

      await expect(growDiskPhase(spec).exec(run)).rejects.toThrow('Failed to inspect cloned VM disk(s)');
    });
  });

  describe('network phase', () => {
    it('runs vm.network.change with -net <network> ethernet-0', async () => {
      const spec: VmSpec = { ...baseSpec, network: 'VM Network' };
      const seen: string[][] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      };
      const network = createPhases(spec, templatePath, undefined, { sleep: noopSleep }).find(
        (ph) => ph.label === 'network',
      )!;

      await network.exec(run);

      expect(seen).toEqual([['govc', 'vm.network.change', '-vm', p.vm, '-net', 'VM Network', 'ethernet-0']]);
    });
  });

  describe('power-on phase', () => {
    it('runs vm.power -on against the VM path', async () => {
      const seen: string[][] = [];
      const run: RunFn = async (cmd, args) => {
        seen.push([cmd, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      };
      const powerOn = createPhases(baseSpec, templatePath, undefined, { sleep: noopSleep }).find(
        (ph) => ph.label === 'power-on',
      )!;

      await powerOn.exec(run);

      expect(seen).toEqual([['govc', 'vm.power', '-on', p.vm]]);
    });
  });
});

describe('makeCreateDryRun', () => {
  it('logs every call and never returns unparseable JSON for device.info', async () => {
    const lines: string[] = [];
    const dryRun = makeCreateDryRun((line) => lines.push(line));

    const cloneResult = await dryRun('govc', ['vm.clone', '-vm', templatePath, 'trust-api-1']);
    const diskResult = await dryRun('govc', ['device.info', '-json', '-vm', p.vm, 'disk-*']);

    expect(cloneResult.code).toBe(0);
    expect(() => JSON.parse(diskResult.stdout) as unknown).not.toThrow();
    expect(lines.some((l) => l.includes('vm.clone'))).toBe(true);
    expect(lines.some((l) => l.includes('device.info'))).toBe(true);
  });

  it('lets the grow-disk phase run end-to-end against the fabricated single-disk response', async () => {
    const spec: VmSpec = { ...baseSpec, diskGb: 100 };
    const lines: string[] = [];
    const dryRun = makeCreateDryRun((line) => lines.push(line));
    const growDisk = createPhases(spec, templatePath, undefined, { sleep: noopSleep }).find(
      (ph) => ph.label === 'grow-disk',
    )!;

    await expect(growDisk.exec(dryRun)).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('vm.disk.change'))).toBe(true);
  });
});

// --- `create` handler: guard + dry-run + guarded execution -----------------

const opts: CreateOptions = {
  name: 'trust-api-1',
  template: 'ubuntu-template-base',
  datacenter: 'ZincApp',
  cluster: 'Primary',
  datastore: 'vsanDatastore',
};

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const notFound = (): RunResult => ({ code: 1, stdout: '', stderr: 'not found' });

function fakeCtx() {
  const info: string[] = [];
  const error: string[] = [];
  const success: string[] = [];
  const warn: string[] = [];
  return {
    ctx: {
      client: { get: async () => ({}) as never, post: async () => ({}) as never },
      output: {
        success: (m: string) => success.push(m),
        error: (m: string) => error.push(m),
        warn: (m: string) => warn.push(m),
        info: (m: string) => info.push(m),
      },
      getConfig: () => ({ url: 'https://vault.test' }),
      isPlainMode: () => true,
    },
    info,
    error,
    success,
    warn,
  };
}

/** All-green fake govc responses covering `plan`'s checks plus template/host resolution. */
function fakeRunAllGreen(): RunFn {
  const responses: Record<string, RunResult> = {
    about: ok(),
    [`find ${p.dc} -type m -name ${opts.template}`]: ok(`${templatePath}\n`),
    [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
    [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
    [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
    [`object.collect -s ${p.folder} name`]: ok('vm\n'),
    [`object.collect -s ${p.vm} name`]: notFound(),
    [`find ${p.cluster} -type h`]: ok('esx1.example.com\n'),
  };
  return async (_cmd, args) => {
    const key = args.join(' ');
    const result = responses[key];
    if (!result) throw new Error(`fakeRun: no canned response for "govc ${key}"`);
    return result;
  };
}

const noopSleepMs = async (_ms: number) => {};

/** True for the `waitForSsh` probe invocation specifically (last arg `"echo ok"`). */
function isSshProbe(args: string[]): boolean {
  return args.at(-1) === 'echo ok';
}

describe('runCreate — --confirm guard', () => {
  afterEachRestoreGovcUrl();

  it('a --confirm that does not match --name touches no run at all and exits 1', async () => {
    const { ctx, error } = fakeCtx();
    let runCalled = false;
    const run: RunFn = async () => {
      runCalled = true;
      return ok();
    };

    const code = await runCreate(ctx, { ...opts, confirm: 'wrong-name' }, run, noopSleepMs);

    expect(code).toBe(1);
    expect(runCalled).toBe(false);
    expect(error.some((l) => l.includes('wrong-name') && l.includes('trust-api-1'))).toBe(true);
  });

  it('a --confirm equal to --name proceeds past the guard (attempts real plan calls)', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx } = fakeCtx();
    let runCalled = false;
    // Deliberately minimal (always succeeds, empty stdout) — this test only
    // asserts the guard let execution through to `run`, not that the plan
    // itself passes; the full happy path is covered separately below.
    const run: RunFn = async () => {
      runCalled = true;
      return ok();
    };

    await runCreate(ctx, { ...opts, confirm: opts.name }, run, noopSleepMs);

    expect(runCalled).toBe(true);
  });
});

describe('runCreate — SSH-key preflight', () => {
  afterEachRestoreGovcUrl();

  it(
    'a missing --ssh-key exits 1 with a clear message and never calls run at all ' +
      '(not even a read-only govc call — the check runs before plan)',
    async () => {
      process.env.GOVC_URL = 'https://vcenter.test';
      const { ctx, error } = fakeCtx();
      const missingKey = join(sshKeyHomeDir, 'does-not-exist-key');
      let runCalled = false;
      const run: RunFn = async () => {
        runCalled = true;
        return ok();
      };

      const code = await runCreate(ctx, { ...opts, confirm: opts.name, sshKey: missingKey }, run, noopSleepMs);

      expect(code).toBe(1);
      expect(runCalled).toBe(false);
      expect(error).toEqual([`SSH key not found: ${missingKey}`]);
    },
  );
});

describe('runCreate — no --confirm (dry-run by default)', () => {
  afterEachRestoreGovcUrl();

  it('runs the plan phase for real, then previews the phases via makeDryRun without any mutation, and exits 0', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info, error } = fakeCtx();
    const mutatingCalls: string[] = [];
    const run: RunFn = async (cmd, args) => {
      // Any govc call that isn't one of `plan`'s read-only checks would be a mutation.
      if (['vm.clone', 'vm.power', 'vm.change', 'vm.disk.change'].includes(args[0] ?? '')) {
        mutatingCalls.push(args.join(' '));
      }
      return fakeRunAllGreen()(cmd, args);
    };

    const code = await runCreate(ctx, opts, run, noopSleepMs);

    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(mutatingCalls).toEqual([]);
    expect(info.some((l) => l.includes('vm.clone'))).toBe(true);
  });
});

describe('runCreate — guarded execution (confirm matches name)', () => {
  afterEachRestoreGovcUrl();

  function fakeRunFullFlow(): RunFn {
    const green = fakeRunAllGreen();
    return async (cmd, args) => {
      if (cmd === 'govc' && args[0] === 'vm.clone') return ok();
      if (cmd === 'govc' && args[0] === 'vm.power') return ok();
      if (cmd === 'govc' && args[0] === 'vm.ip') return ok('172.16.211.30');
      if (cmd === 'ssh') return ok('ok');
      return green(cmd, args);
    };
  }

  it('clone -> power-on -> wait-ip -> wait-ssh -> bootstrap succeed: reports success and exits 0', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, success, error } = fakeCtx();

    const code = await runCreate(ctx, { ...opts, confirm: opts.name }, fakeRunFullFlow(), noopSleepMs);

    expect(error).toEqual([]);
    expect(code).toBe(0);
    expect(success.some((l) => l.includes('172.16.211.30'))).toBe(true);
  });

  it('a non-zero ssh bootstrap exit code is NOT lost: reported and exits 1 with a retry hint', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error, info } = fakeCtx();
    const run: RunFn = async (cmd, args) => {
      // The `waitForSsh` probe must still succeed so the flow reaches the
      // actual bootstrap invocation — only THAT ssh call fails here.
      if (cmd === 'ssh' && isSshProbe(args)) return ok('ok');
      if (cmd === 'ssh') return { code: 7, stdout: '', stderr: 'bootstrap script failed' };
      return fakeRunFullFlow()(cmd, args);
    };

    const code = await runCreate(ctx, { ...opts, confirm: opts.name }, run, noopSleepMs);

    expect(code).toBe(1);
    expect(error.some((l) => l.includes('7'))).toBe(true);
    expect(info.some((l) => l.includes('enroll --retry-bootstrap'))).toBe(true);
  });

  it('a timeout waiting for the VM IP reports the failure without ever calling ssh', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error, info } = fakeCtx();
    let sshCalled = false;
    const run: RunFn = async (cmd, args) => {
      if (cmd === 'ssh') {
        sshCalled = true;
        return ok('ok');
      }
      if (cmd === 'govc' && args[0] === 'vm.ip') return ok(''); // never resolves
      return fakeRunFullFlow()(cmd, args);
    };

    // Shrink the wait budget via --timeout-minutes so the (fake-instant)
    // poll loop doesn't run the full 10-minute default iteration count.
    const code = await runCreate(ctx, { ...opts, confirm: opts.name, timeoutMinutes: '1' }, run, noopSleepMs);

    expect(code).toBe(1);
    expect(sshCalled).toBe(false);
    expect(error.some((l) => /timeout/i.test(l))).toBe(true);
    expect(info.some((l) => l.includes('VM created but bootstrap not run'))).toBe(true);
  });
});

describe('runCreate — --fleet chaining decision (not the enrollment pipeline itself, see enroll.test.ts)', () => {
  afterEachRestoreGovcUrl();

  function fakeRunFullFlow(): RunFn {
    const green = fakeRunAllGreen();
    return async (cmd, args) => {
      if (cmd === 'govc' && args[0] === 'vm.clone') return ok();
      if (cmd === 'govc' && args[0] === 'vm.power') return ok();
      if (cmd === 'govc' && args[0] === 'vm.ip') return ok('172.16.211.30');
      if (cmd === 'ssh') return ok('ok');
      return green(cmd, args);
    };
  }

  /** Records every invocation instead of doing real enrollment work — this suite only asserts whether/with-what-args it's called, not its internals (see enroll.test.ts for those). */
  function fakeEnroll(result: number): { enroll: typeof runEnroll; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const enroll: typeof runEnroll = async (ctxArg, optsArg, runArg) => {
      calls.push([ctxArg, optsArg, runArg]);
      return result;
    };
    return { enroll, calls };
  }

  it('no --fleet: enroll is never called, and the summary reports "skipped (no --fleet)"', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info } = fakeCtx();
    const { enroll, calls } = fakeEnroll(0);

    const code = await runCreate(ctx, { ...opts, confirm: opts.name }, fakeRunFullFlow(), noopSleepMs, enroll);

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(info.some((l) => l.includes('skipped (no --fleet)'))).toBe(true);
  });

  it('--fleet given but bootstrap failed: enroll is never called, a warning is shown, and the summary says so', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error, info, warn } = fakeCtx();
    const { enroll, calls } = fakeEnroll(0);
    const run: RunFn = async (cmd, args) => {
      if (cmd === 'ssh' && isSshProbe(args)) return ok('ok');
      if (cmd === 'ssh') return { code: 7, stdout: '', stderr: 'bootstrap script failed' };
      return fakeRunFullFlow()(cmd, args);
    };

    const code = await runCreate(ctx, { ...opts, confirm: opts.name, fleet: 'trust-fleet' }, run, noopSleepMs, enroll);

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(error.some((l) => l.includes('7'))).toBe(true);
    expect(warn.some((l) => l.includes('trust-fleet') && l.includes('skipping enrollment'))).toBe(true);
    expect(info.some((l) => l.includes('skipped (bootstrap failed)'))).toBe(true);
  });

  it('--fleet given and bootstrap succeeded: enroll is called once with {fleet, name, ip, sshUser, sshKey}, and success propagates (exit 0, "enrolled")', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info } = fakeCtx();
    const { enroll, calls } = fakeEnroll(0);

    const code = await runCreate(
      ctx,
      { ...opts, confirm: opts.name, fleet: 'trust-fleet' },
      fakeRunFullFlow(),
      noopSleepMs,
      enroll,
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const [, enrollOpts] = calls[0]!;
    expect(enrollOpts).toEqual({
      fleet: 'trust-fleet',
      name: 'trust-api-1',
      ip: '172.16.211.30',
      sshUser: 'sysadmin',
      sshKey: '~/.ssh/id_ed25519',
    });
    expect(info.some((l) => l.includes('Agent: enrolled'))).toBe(true);
  });

  it('--fleet given, bootstrap succeeded, but enrollment fails: exit code is 1 and the summary says "enrollment failed"', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info } = fakeCtx();
    const { enroll, calls } = fakeEnroll(1);

    const code = await runCreate(
      ctx,
      { ...opts, confirm: opts.name, fleet: 'trust-fleet' },
      fakeRunFullFlow(),
      noopSleepMs,
      enroll,
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(info.some((l) => l.includes('Agent: enrollment failed'))).toBe(true);
  });
});

/** Shared teardown: restore GOVC_URL after each test in the enclosing describe. */
function afterEachRestoreGovcUrl(): void {
  const original = process.env.GOVC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.GOVC_URL;
    else process.env.GOVC_URL = original;
  });
}
