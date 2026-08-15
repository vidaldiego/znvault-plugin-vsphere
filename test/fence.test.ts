import { describe, expect, it } from 'vitest';
import type { CLIPluginContext } from '../src/plugin-types.js';
import type { RunFn, RunResult } from '../src/run.js';
import {
  FENCE_CONFIRMATION,
  FENCE_SOURCE_VMS,
  powerOffArgs,
  runFenceSource,
  runFenceStatus,
} from '../src/fence.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function fakeCtx(endpoint = 'https://vcenter.zincapp.com') {
  const info: string[] = [];
  const error: string[] = [];
  const success: string[] = [];
  const vaultCalls: string[] = [];
  const ctx: CLIPluginContext = {
    client: {
      get: async (path) => {
        vaultCalls.push(`GET ${path}`);
        return {
          id: 'test-vcenter-secret',
          alias: 'infra/vsphere/leganes/vcenter',
          type: 'credential',
        } as never;
      },
      post: async (path) => {
        vaultCalls.push(`POST ${path}`);
        return {
          id: 'test-vcenter-secret',
          alias: 'infra/vsphere/leganes/vcenter',
          type: 'credential',
          data: {
            url: endpoint,
            username: 'test-user',
            password: 'test-password',
            insecure: false,
          },
        } as never;
      },
    },
    output: {
      success: (message) => success.push(message),
      error: (message) => error.push(message),
      warn() {},
      info: (message) => info.push(message),
    },
    getConfig: () => ({ url: 'https://vault.test' }),
    isPlainMode: () => true,
  };
  return { ctx, info, error, success, vaultCalls };
}

function vmInfo(index: number, powerState: 'poweredOn' | 'poweredOff'): string {
  const vm = FENCE_SOURCE_VMS[index]!;
  return JSON.stringify({
    virtualMachines: [{
      self: { type: 'VirtualMachine', value: vm.moref },
      config: { name: vm.name, uuid: vm.biosUuid, instanceUuid: vm.instanceUuid },
      summary: { runtime: { powerState } },
    }],
  });
}

function observationRun(
  before: 'poweredOn' | 'poweredOff',
  after: 'poweredOn' | 'poweredOff' = before,
) {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  let reads = 0;
  const run: RunFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    if (args[0] === 'vm.power') return ok();
    const index = reads % FENCE_SOURCE_VMS.length;
    const phase = reads < FENCE_SOURCE_VMS.length ? before : after;
    reads += 1;
    return ok(vmInfo(index, phase));
  };
  return { run, calls };
}

describe('fixed LAB source fence', () => {
  it('builds one fixed power-off argv with all four immutable inventory paths', () => {
    expect(powerOffArgs()).toEqual([
      'vm.power',
      '-off',
      '-force=true',
      '-wait=true',
      ...FENCE_SOURCE_VMS.map((vm) => vm.inventoryPath),
    ]);
  });

  it('dry-run refuses with NONE/NO_GO without reading Vault or invoking govc', async () => {
    const { ctx, info, vaultCalls } = fakeCtx();
    const run: RunFn = async () => { throw new Error('must remain inert'); };

    const code = await runFenceSource(ctx, {}, run);

    expect(code).toBe(78);
    expect(vaultCalls).toEqual([]);
    expect(info).toContain('Result: INERT_REFUSAL');
    expect(info).toContain('Effects: NONE');
    expect(info).toContain('Decision: NO_GO');
  });

  it('wrong confirmation refuses before Vault and govc', async () => {
    const { ctx, vaultCalls } = fakeCtx();
    let ran = false;
    const run: RunFn = async () => { ran = true; return ok(); };

    const code = await runFenceSource(ctx, { confirm: 'wrong' }, run);

    expect(code).toBe(78);
    expect(vaultCalls).toEqual([]);
    expect(ran).toBe(false);
  });

  it('status is read-only and returns NO_GO while any fixed source VM is on', async () => {
    const { ctx, info } = fakeCtx();
    const { run, calls } = observationRun('poweredOn');

    const code = await runFenceStatus(ctx, run);

    expect(code).toBe(78);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.args[0] === 'vm.info')).toBe(true);
    expect(info).toContain('Result: UNFENCED');
    expect(info).toContain('Effects: NONE');
    expect(info).toContain('Decision: NO_GO');
  });

  it('exact confirmation validates all identities, executes one power-off, then verifies all four off', async () => {
    const { ctx, success } = fakeCtx();
    const { run, calls } = observationRun('poweredOn', 'poweredOff');

    const code = await runFenceSource(ctx, { confirm: FENCE_CONFIRMATION }, run);

    expect(code).toBe(0);
    expect(calls).toHaveLength(9);
    expect(calls[4]?.args).toEqual(powerOffArgs());
    expect(calls.every((call) => call.cmd === 'govc')).toBe(true);
    expect(calls.every((call) => call.env?.GOVC_PASSWORD === 'test-password')).toBe(true);
    expect(success).toContain('Result: FENCED');
  });

  it('already-fenced execution is idempotent and issues no power command', async () => {
    const { ctx } = fakeCtx();
    const { run, calls } = observationRun('poweredOff');

    const code = await runFenceSource(ctx, { confirm: FENCE_CONFIRMATION }, run);

    expect(code).toBe(0);
    expect(calls).toHaveLength(8);
    expect(calls.some((call) => call.args[0] === 'vm.power')).toBe(false);
  });

  it('refuses an unexpected endpoint before any govc call', async () => {
    const { ctx, error } = fakeCtx('https://other-vcenter.test');
    let ran = false;
    const run: RunFn = async () => { ran = true; return ok(); };

    const code = await runFenceSource(ctx, { confirm: FENCE_CONFIRMATION }, run);

    expect(code).toBe(78);
    expect(ran).toBe(false);
    expect(error[0]).toMatch(/unexpected vCenter endpoint/);
  });

  it('identity mismatch refuses before the power command', async () => {
    const { ctx, error } = fakeCtx();
    const calls: string[][] = [];
    const run: RunFn = async (_cmd, args) => {
      calls.push(args);
      return ok(JSON.stringify({ virtualMachines: [] }));
    };

    const code = await runFenceSource(ctx, { confirm: FENCE_CONFIRMATION }, run);

    expect(code).toBe(78);
    expect(calls.some((args) => args[0] === 'vm.power')).toBe(false);
    expect(error[0]).toMatch(/Identity mismatch/);
  });
});
