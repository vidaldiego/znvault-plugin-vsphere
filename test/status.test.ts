// Path: test/status.test.ts
// `summarizeStatus` (pure core, the 4 canonical combinations from the task
// brief) and the `runStatus` handler (I/O orchestration: govc vm.info/vm.ip
// + ssh probes), driven entirely by a fake `RunFn` — no real govc/ssh/
// vCenter is ever invoked.

import { describe, it, expect, afterEach } from 'vitest';
import type { RunFn, RunResult } from '../src/run.js';
import { summarizeStatus, runStatus, type StatusInputs, type StatusOptions } from '../src/status.js';

// --- summarizeStatus (pure core) ------------------------------------------

describe('summarizeStatus', () => {
  it('created-no-ip: VM exists and is powered on, but has no IP yet — SSH/agent are not checked', () => {
    const inputs: StatusInputs = { powerState: 'poweredOn', ip: undefined, sshOk: false, agentOk: false };

    expect(summarizeStatus(inputs)).toEqual({
      power: 'poweredOn',
      ip: 'not assigned',
      ssh: 'not checked (no IP)',
      agent: 'not checked (no IP)',
    });
  });

  it('ip-no-ssh: VM has an IP but the SSH probe fails — agent is not checked', () => {
    const inputs: StatusInputs = { powerState: 'poweredOn', ip: '172.16.211.30', sshOk: false, agentOk: false };

    expect(summarizeStatus(inputs)).toEqual({
      power: 'poweredOn',
      ip: '172.16.211.30',
      ssh: 'unreachable',
      agent: 'not checked (ssh unreachable)',
    });
  });

  it('ssh-no-agent: SSH is reachable but the agent health check fails', () => {
    const inputs: StatusInputs = { powerState: 'poweredOn', ip: '172.16.211.30', sshOk: true, agentOk: false };

    expect(summarizeStatus(inputs)).toEqual({
      power: 'poweredOn',
      ip: '172.16.211.30',
      ssh: 'reachable',
      agent: 'unhealthy',
    });
  });

  it('all-green: power on, IP assigned, SSH reachable, agent healthy', () => {
    const inputs: StatusInputs = { powerState: 'poweredOn', ip: '172.16.211.30', sshOk: true, agentOk: true };

    expect(summarizeStatus(inputs)).toEqual({
      power: 'poweredOn',
      ip: '172.16.211.30',
      ssh: 'reachable',
      agent: 'healthy',
    });
  });

  it('reports an unknown power state verbatim (e.g. poweredOff) without touching ssh/agent fields', () => {
    const inputs: StatusInputs = { powerState: 'poweredOff', ip: undefined, sshOk: false, agentOk: false };

    expect(summarizeStatus(inputs).power).toBe('poweredOff');
  });
});

// --- runStatus (handler) ---------------------------------------------------

const opts: StatusOptions = { name: 'trust-api-1' };

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'error'): RunResult => ({ code: 1, stdout: '', stderr });

function fakeCtx() {
  const info: string[] = [];
  const error: string[] = [];
  return {
    ctx: {
      client: { get: async () => ({}) as never, post: async () => ({}) as never },
      output: {
        success: () => {},
        error: (m: string) => error.push(m),
        warn: () => {},
        info: (m: string) => info.push(m),
      },
      getConfig: () => ({ url: 'https://vault.test' }),
      isPlainMode: () => true,
    },
    info,
    error,
  };
}

const vmInfoJson = (powerState: string): string =>
  JSON.stringify({ virtualMachines: [{ summary: { runtime: { powerState } } }] });

describe('runStatus', () => {
  const originalGovcUrl = process.env.GOVC_URL;

  afterEach(() => {
    if (originalGovcUrl === undefined) delete process.env.GOVC_URL;
    else process.env.GOVC_URL = originalGovcUrl;
  });

  it('reports the missing GOVC_URL error and exits 1 without invoking govc', async () => {
    delete process.env.GOVC_URL;
    const { ctx, error } = fakeCtx();
    const run: RunFn = async () => {
      throw new Error('run should not be called when GOVC_URL is missing');
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(1);
    expect(error[0]).toMatch(/GOVC_URL/);
  });

  it('VM not found (empty virtualMachines array from govc): exits 1 with a clear message, no ip/ssh calls', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run: RunFn = async (_cmd, args) => {
      if (args[0] === 'vm.info') return ok(JSON.stringify({ virtualMachines: [] }));
      throw new Error(`unexpected call: govc ${args.join(' ')}`);
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(1);
    expect(error).toEqual([`VM not found: ${opts.name}`]);
  });

  it('govc vm.info itself fails (connection issue): exits 1 with the query-failure message, not "VM not found"', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, error } = fakeCtx();
    const run: RunFn = async (_cmd, args) => {
      if (args[0] === 'vm.info') return fail('connection refused');
      throw new Error(`unexpected call: govc ${args.join(' ')}`);
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(1);
    expect(error[0]).toMatch(/Failed to query VM status/);
    expect(error[0]).toMatch(/connection refused/);
  });

  it('created-no-ip: powered on, govc vm.ip comes up empty — returns 0 (status reports, it does not gate) and never attempts ssh', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info, error } = fakeCtx();
    const run: RunFn = async (cmd, args) => {
      if (args[0] === 'vm.info') return ok(vmInfoJson('poweredOn'));
      if (args[0] === 'vm.ip') return ok('');
      if (cmd === 'ssh') throw new Error('ssh should not be called without an IP');
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(info.some((l) => l.includes('not assigned'))).toBe(true);
    expect(info.some((l) => l.includes('not checked (no IP)'))).toBe(true);
  });

  it('all-green: power on, IP resolved, ssh echo ok, agent curl succeeds — exits 0 with a full summary', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info } = fakeCtx();
    const seen: string[][] = [];
    const run: RunFn = async (cmd, args) => {
      seen.push([cmd, ...args]);
      if (args[0] === 'vm.info') return ok(vmInfoJson('poweredOn'));
      if (args[0] === 'vm.ip') return ok('172.16.211.30,fe80::1');
      if (cmd === 'ssh' && args.some((a) => a.includes('echo ok'))) return ok('ok\n');
      if (cmd === 'ssh' && args.some((a) => a.includes('curl'))) return ok('{"status":"ok"}');
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(0);
    expect(info.some((l) => l.includes('172.16.211.30'))).toBe(true);
    expect(info.some((l) => l.includes('reachable'))).toBe(true);
    expect(info.some((l) => l.includes('healthy'))).toBe(true);
    // vm.ip called with the documented best-effort 5s wait.
    expect(seen.some((c) => c.join(' ').includes('vm.ip -a -v4 -wait=5s'))).toBe(true);
  });

  it('ip-no-ssh: IP resolved but the ssh probe fails — exits 0 (degraded, not an error) and never attempts the agent curl', async () => {
    process.env.GOVC_URL = 'https://vcenter.test';
    const { ctx, info, error } = fakeCtx();
    const run: RunFn = async (cmd, args) => {
      if (args[0] === 'vm.info') return ok(vmInfoJson('poweredOn'));
      if (args[0] === 'vm.ip') return ok('172.16.211.30');
      if (cmd === 'ssh' && args.some((a) => a.includes('echo ok'))) return fail('Connection refused');
      if (cmd === 'ssh' && args.some((a) => a.includes('curl'))) throw new Error('agent curl should not run when ssh is unreachable');
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };

    const code = await runStatus(ctx, opts, run);

    expect(code).toBe(0);
    expect(error).toEqual([]);
    expect(info.some((l) => l.includes('unreachable'))).toBe(true);
  });
});
