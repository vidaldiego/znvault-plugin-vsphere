// Path: test/commands-plan.test.ts
// `plan` handler tests, driven by a fake `RunFn` — no real govc/vCenter is
// ever invoked. `runPlan` is exported precisely so this can call it directly
// instead of going through commander + `process.exit` (see its doc comment
// in src/commands.ts for the pattern this follows).

import { describe, it, expect, afterEach } from 'vitest';
import type { RunFn, RunResult } from '../src/run.js';
import { paths } from '../src/vm-spec.js';
import { runPlan, type PlanOptions } from '../src/commands.js';

const opts: PlanOptions = {
  name: 'trust-api-1',
  template: 'ubuntu-template-base',
  datacenter: 'ZincApp',
  cluster: 'Primary',
  datastore: 'vsanDatastore',
};

const templatePath = '/ZincApp/vm/ubuntu-template-base';
const p = paths({ ...opts, sshUser: 'sysadmin', sshKey: '~/.ssh/id_ed25519', timeoutMinutes: 10 });

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const notFound = (): RunResult => ({ code: 1, stdout: '', stderr: 'not found' });

function fakeCtx() {
  const info: string[] = [];
  const error: string[] = [];
  const success: string[] = [];
  return {
    ctx: {
      client: { get: async () => ({}) as never, post: async () => ({}) as never },
      output: {
        success: (m: string) => success.push(m),
        error: (m: string) => error.push(m),
        warn: () => {},
        info: (m: string) => info.push(m),
      },
      getConfig: () => ({ url: 'https://vault.test' }),
      isPlainMode: () => true,
    },
    info,
    error,
    success,
  };
}

/** All-green fakeRun: `govc about`, template resolution, every check passes.
 * `opts` pins no `--host`, so `validationSteps` appends the "cluster has at
 * least one host" check instead of host property checks — canned here too. */
function fakeRunAllGreen(): RunFn {
  const responses: Record<string, RunResult> = {
    about: ok(''),
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

describe('runPlan', () => {
  const originalGovcUrl = process.env.GOVC_URL;
  const originalGovcUser = process.env.GOVC_USERNAME;
  const originalGovcPassword = process.env.GOVC_PASSWORD;

  afterEach(() => {
    if (originalGovcUrl === undefined) delete process.env.GOVC_URL;
    else process.env.GOVC_URL = originalGovcUrl;
    if (originalGovcUser === undefined) delete process.env.GOVC_USERNAME;
    else process.env.GOVC_USERNAME = originalGovcUser;
    if (originalGovcPassword === undefined) delete process.env.GOVC_PASSWORD;
    else process.env.GOVC_PASSWORD = originalGovcPassword;
  });

  it('no longer prints the Task-1 stub message', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();

    await runPlan(ctx, opts, fakeRunAllGreen());

    expect(error).not.toContain('vsphere plan: not implemented yet');
  });

  it('all-green: prints a ✓ line per check and returns exit code 0', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info, success, error } = fakeCtx();

    const code = await runPlan(ctx, opts, fakeRunAllGreen());

    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(info.some((l) => l.includes('✓ Cluster exists'))).toBe(true);
    expect(info.some((l) => l.includes('✓ Datastore accessible'))).toBe(true);
    expect(info.some((l) => l.includes('✓ No naming collision'))).toBe(true);
    expect(success.some((l) => l.includes('Plan validation passed'))).toBe(true);
  });

  it('a failing check is printed with ✗ and its failure message, and returns exit code 1', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run = fakeRunAllGreen();
    const failingRun: RunFn = async (cmd, args) => {
      if (args.join(' ') === `object.collect -s ${p.datastore} summary.accessible`) {
        return { code: 0, stdout: 'false\n', stderr: '' };
      }
      return run(cmd, args);
    };

    const code = await runPlan(ctx, opts, failingRun);

    expect(code).toBe(1);
    expect(error.some((l) => l.includes('✗ Datastore accessible') && l.includes('not accessible'))).toBe(true);
    expect(error.some((l) => l.includes('Plan validation failed'))).toBe(true);
  });

  it('reports "Cannot connect to vCenter" and exits 1 when `govc about` fails', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run: RunFn = async () => ({ code: 1, stdout: '', stderr: 'connection refused' });

    const code = await runPlan(ctx, opts, run);

    expect(code).toBe(1);
    expect(error).toEqual(['Cannot connect to vCenter at https://vcenter.test']);
  });

  it('reports the missing GOVC_URL error and exits 1 without invoking govc', async () => {
    delete process.env.GOVC_URL;
    const { ctx, error } = fakeCtx();
    const run: RunFn = async () => {
      throw new Error('run should not be called when GOVC_URL is missing');
    };

    const code = await runPlan(ctx, opts, run);

    expect(code).toBe(1);
    expect(error[0]).toMatch(/GOVC_URL/);
  });

  it('rejects a non-positive-integer --disk-gb before touching govc', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run: RunFn = async () => {
      throw new Error('run should not be called for an invalid --disk-gb');
    };

    const code = await runPlan(ctx, { ...opts, diskGb: '0' }, run);

    expect(code).toBe(1);
    expect(error[0]).toMatch(/--disk-gb must be a positive integer/);
  });

  it('template not found: reports the resolveTemplate error and exits 1', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run: RunFn = async (_cmd, args) => {
      if (args[0] === 'about') return ok('');
      if (args[0] === 'find') return ok(''); // both -type m and -type VirtualMachine come up empty
      throw new Error(`unexpected call: govc ${args.join(' ')}`);
    };

    const code = await runPlan(ctx, opts, run);

    expect(code).toBe(1);
    expect(error[0]).toMatch(/Template 'ubuntu-template-base' not found in ZincApp/);
  });

  it('disk precheck: a shrink refusal is printed and fails the plan', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run = fakeRunAllGreen();
    const withDisk: RunFn = async (cmd, args) => {
      if (args[0] === 'device.info') {
        return ok(JSON.stringify({ devices: [{ capacityInBytes: 100 * 1_073_741_824 }] }));
      }
      return run(cmd, args);
    };

    const code = await runPlan(ctx, { ...opts, diskGb: '50' }, withDisk);

    expect(code).toBe(1);
    expect(error.some((l) => l.includes('cannot shrink the 100GB template disk'))).toBe(true);
  });

  it('no --host given, cluster has zero hosts: fails with the script\'s "No hosts found" message', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run = fakeRunAllGreen();
    const noHosts: RunFn = async (cmd, args) => {
      if (args.join(' ') === `find ${p.cluster} -type h`) return ok('');
      return run(cmd, args);
    };

    const code = await runPlan(ctx, opts, noHosts);

    expect(code).toBe(1);
    expect(error.some((l) => l.includes(`No hosts found in cluster ${opts.cluster}`))).toBe(true);
  });

  it('--host pinned and resolved: runs the green/connected/maintenance checks instead of the no-host check, and passes', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error, success } = fakeCtx();
    const hostPath = `${p.cluster}/esx1.example.com`;
    const run = fakeRunAllGreen();
    const withHost: RunFn = async (cmd, args) => {
      const key = args.join(' ');
      if (key === `find ${p.cluster} -type h -name esx1`) return ok(`${hostPath}\n`);
      if (key === `object.collect -s ${hostPath} name`) return ok('esx1.example.com\n');
      if (key === `object.collect -s ${hostPath} overallStatus`) return ok('green\n');
      if (key === `object.collect -s ${hostPath} runtime.connectionState`) return ok('connected\n');
      if (key === `object.collect -s ${hostPath} runtime.inMaintenanceMode`) return ok('false\n');
      // The no-host "cluster has at least one host" step must NOT run once a host is pinned.
      if (key === `find ${p.cluster} -type h`) {
        throw new Error('unexpected: no-host check ran despite --host being pinned');
      }
      return run(cmd, args);
    };

    const code = await runPlan(ctx, { ...opts, host: 'esx1' }, withHost);

    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(success.some((l) => l.includes('Plan validation passed'))).toBe(true);
  });

  it('--host pinned but not found in cluster: bails early with the resolution error, before any per-step output', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error, info } = fakeCtx();
    const run = fakeRunAllGreen();
    const hostNotFound: RunFn = async (cmd, args) => {
      if (args.join(' ') === `find ${p.cluster} -type h -name ghost`) return ok('');
      return run(cmd, args);
    };

    const code = await runPlan(ctx, { ...opts, host: 'ghost' }, hostNotFound);

    expect(code).toBe(1);
    expect(error).toEqual([`Host 'ghost' not found in cluster ${opts.cluster}`]);
    expect(info.some((l) => l.includes('✓') || l.includes('✗'))).toBe(false);
  });
});
