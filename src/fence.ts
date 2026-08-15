import type { Command } from 'commander';
import type { CLIPluginContext } from './plugin-types.js';
import { execRun, type RunFn } from './run.js';
import {
  DEFAULT_VCENTER_CREDENTIAL_ALIAS,
  resolveVcenterRun,
} from './vault-credentials.js';

export const FENCE_CONFIRMATION = 'FENCE-SOURCE-LEG-LAB';
export const FENCE_VCENTER_ENDPOINT = 'https://vcenter.zincapp.com';

export interface FenceVm {
  moref: string;
  name: string;
  inventoryPath: string;
  biosUuid: string;
  instanceUuid: string;
}

export const FENCE_SOURCE_VMS: readonly FenceVm[] = [
  {
    moref: 'vm-7020',
    name: 'vault-leg-lab-1',
    inventoryPath: '/ZincApp/vm/Secondary/Vault DR Lab/vault-leg-lab-1',
    biosUuid: '423565e6-89e7-141f-b15f-05cc4ec384a6',
    instanceUuid: '5035e9ec-8026-7a8c-abc4-bb7c5cb607d2',
  },
  {
    moref: 'vm-7021',
    name: 'vault-pg-leg-lab-1',
    inventoryPath: '/ZincApp/vm/Secondary/Vault DR Lab/vault-pg-leg-lab-1',
    biosUuid: '423537eb-99dd-6e76-6f75-bcf6a085f7e3',
    instanceUuid: '50358b4b-f701-e27a-6f3a-5b634f9c7bda',
  },
  {
    moref: 'vm-7024',
    name: 'vault-pg-leg-lab-2',
    inventoryPath: '/ZincApp/vm/Secondary/Vault DR Lab/vault-pg-leg-lab-2',
    biosUuid: '4235003e-bee5-710d-aee7-27ecd4b507ac',
    instanceUuid: '5035e7f1-a5de-4096-73f8-b930d11fa9d5',
  },
  {
    moref: 'vm-7025',
    name: 'vault-pg-leg-lab-3',
    inventoryPath: '/ZincApp/vm/Secondary/Vault DR Lab/vault-pg-leg-lab-3',
    biosUuid: '42350485-6a64-53c9-7824-c7d582aaad79',
    instanceUuid: '503595e2-f217-6c5a-c427-ca69db495b2c',
  },
] as const;

interface GovcVmInfo {
  virtualMachines?: Array<{
    self?: { value?: string };
    config?: { name?: string; uuid?: string; instanceUuid?: string };
    summary?: { runtime?: { powerState?: string } };
  }>;
}

export interface FenceObservation {
  vm: FenceVm;
  powerState: string;
}

export function powerOffArgs(): string[] {
  return ['vm.power', '-off', '-force=true', '-wait=true', ...FENCE_SOURCE_VMS.map((vm) => vm.inventoryPath)];
}

function parseAndValidateVm(stdout: string, expected: FenceVm): FenceObservation {
  let parsed: GovcVmInfo;
  try {
    parsed = JSON.parse(stdout) as GovcVmInfo;
  } catch {
    throw new Error(`Invalid vCenter response for fixed LAB VM '${expected.name}'`);
  }

  const actual = parsed.virtualMachines?.[0];
  const powerState = actual?.summary?.runtime?.powerState;
  if (
    parsed.virtualMachines?.length !== 1 ||
    actual?.self?.value !== expected.moref ||
    actual?.config?.name !== expected.name ||
    actual?.config?.uuid?.toLowerCase() !== expected.biosUuid ||
    actual?.config?.instanceUuid?.toLowerCase() !== expected.instanceUuid ||
    (powerState !== 'poweredOn' && powerState !== 'poweredOff')
  ) {
    throw new Error(`Identity mismatch for fixed LAB VM '${expected.name}'`);
  }
  return { vm: expected, powerState };
}

export async function observeFenceSource(run: RunFn): Promise<FenceObservation[]> {
  const observations: FenceObservation[] = [];
  for (const vm of FENCE_SOURCE_VMS) {
    const result = await run('govc', ['vm.info', '-json', vm.inventoryPath]);
    if (result.code !== 0) throw new Error(`Cannot inspect fixed LAB VM '${vm.name}'`);
    observations.push(parseAndValidateVm(result.stdout, vm));
  }
  return observations;
}

async function resolveFixedVcenter(ctx: CLIPluginContext, run: RunFn) {
  const vcenter = await resolveVcenterRun(ctx, run, DEFAULT_VCENTER_CREDENTIAL_ALIAS);
  if (vcenter.endpoint !== FENCE_VCENTER_ENDPOINT) {
    throw new Error(`Fixed LAB fence refuses unexpected vCenter endpoint '${vcenter.endpoint}'`);
  }
  return vcenter;
}

function reportObservation(ctx: CLIPluginContext, observations: FenceObservation[]): boolean {
  for (const observation of observations) {
    ctx.output.info(`  ${observation.vm.moref} ${observation.vm.name}: ${observation.powerState}`);
  }
  return observations.every((observation) => observation.powerState === 'poweredOff');
}

export async function runFenceStatus(ctx: CLIPluginContext, run: RunFn = execRun): Promise<number> {
  try {
    const vcenter = await resolveFixedVcenter(ctx, run);
    const observations = await observeFenceSource(vcenter.run);
    const fenced = reportObservation(ctx, observations);
    ctx.output.info(`Result: ${fenced ? 'FENCED' : 'UNFENCED'}`);
    ctx.output.info('Effects: NONE');
    ctx.output.info(`Decision: ${fenced ? 'GO' : 'NO_GO'}`);
    return fenced ? 0 : 78;
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    ctx.output.info('Effects: NONE');
    ctx.output.info('Decision: NO_GO');
    return 78;
  }
}

export interface FenceSourceOptions {
  confirm?: string;
}

function previewFenceSource(ctx: CLIPluginContext): number {
  ctx.output.info('Fixed LAB source fence plan:');
  for (const vm of FENCE_SOURCE_VMS) ctx.output.info(`  power off ${vm.moref} ${vm.inventoryPath}`);
  ctx.output.info('Result: INERT_REFUSAL');
  ctx.output.info('Effects: NONE');
  ctx.output.info('Decision: NO_GO');
  ctx.output.info(`Re-run with --confirm ${FENCE_CONFIRMATION} to execute.`);
  return 78;
}

export async function runFenceSource(
  ctx: CLIPluginContext,
  opts: FenceSourceOptions,
  run: RunFn = execRun,
): Promise<number> {
  if (opts.confirm === undefined) return previewFenceSource(ctx);
  if (opts.confirm !== FENCE_CONFIRMATION) {
    ctx.output.error('Fence confirmation does not match the fixed LAB token.');
    ctx.output.info('Effects: NONE');
    ctx.output.info('Decision: NO_GO');
    return 78;
  }

  try {
    const vcenter = await resolveFixedVcenter(ctx, run);
    const before = await observeFenceSource(vcenter.run);
    if (!before.every((observation) => observation.powerState === 'poweredOff')) {
      const result = await vcenter.run('govc', powerOffArgs());
      if (result.code !== 0) throw new Error('Fixed LAB source power-off command failed');
    }

    const after = await observeFenceSource(vcenter.run);
    if (!reportObservation(ctx, after)) throw new Error('Fixed LAB source fence verification failed');
    ctx.output.success('Result: FENCED');
    ctx.output.info('Effects: SOURCE_FENCED');
    ctx.output.info('Decision: GO');
    return 0;
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    ctx.output.info('Decision: NO_GO');
    return 78;
  }
}

export function registerFenceCommands(vsphere: Command, ctx: CLIPluginContext): void {
  vsphere
    .command('fence-status')
    .description('Verify the fixed Leganés LAB source fence (read-only)')
    .action(async () => {
      const code = await runFenceStatus(ctx);
      if (code !== 0) process.exit(code);
    });

  vsphere
    .command('fence-source')
    .description('Fence the four fixed Leganés LAB source VMs (dry-run by default)')
    .option('--confirm <token>', `Exact execution token: ${FENCE_CONFIRMATION}`)
    .action(async (opts: FenceSourceOptions) => {
      const code = await runFenceSource(ctx, opts);
      if (code !== 0) process.exit(code);
    });
}
