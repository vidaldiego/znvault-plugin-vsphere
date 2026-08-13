// Path: src/commands.ts
// Registers the `znvault vsphere <sub>` subcommands. `plan` (Task 3) is a
// real, read-only preflight; `create`/`enroll`/`status` remain stubs for
// Tasks 4-5.

import type { Command } from 'commander';
import type { CLIPluginContext } from './plugin-types.js';
import { execRun, requireGovcEnv, type RunFn } from './run.js';
import type { VmSpec } from './vm-spec.js';
import { resolveTargetHost, resolveTemplate, runValidations, validationSteps } from './validate.js';

/** Stub handler shared by every subcommand whose task hasn't landed yet. */
function notImplemented(ctx: CLIPluginContext, subcommand: string): void {
  ctx.output.error(`vsphere ${subcommand}: not implemented yet`);
  process.exit(1);
}

/** Raw `--flag <value>` strings as commander hands them to the `plan` action. */
export interface PlanOptions {
  name: string;
  template: string;
  datacenter: string;
  cluster: string;
  datastore: string;
  folder?: string;
  network?: string;
  host?: string;
  numCpu?: string;
  memoryGb?: string;
  diskGb?: string;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Validates a numeric CLI option the same way the proven script does
 * (`validate_positive_integer`, lines 163-171): must match `^[1-9][0-9]*$`,
 * i.e. no zero, no negative, no leading zero, no decimal.
 */
function parsePositiveInt(optionName: string, raw: string): number {
  if (!POSITIVE_INTEGER.test(raw)) {
    throw new Error(`${optionName} must be a positive integer (got '${raw}')`);
  }
  return Number(raw);
}

/**
 * Builds the `VmSpec` `plan` needs for its read-only checks. `sshUser`/
 * `sshKey`/`timeoutMinutes` are required by `VmSpec` but unused by any
 * validation this command performs (`paths`/`validationSteps` never touch
 * them) — they're filled with the script's own defaults so this spec would
 * still be usable as-is if `create` (Task 4) is ever handed the same object.
 */
function buildVmSpec(opts: PlanOptions): VmSpec {
  return {
    name: opts.name,
    template: opts.template,
    datacenter: opts.datacenter,
    cluster: opts.cluster,
    datastore: opts.datastore,
    folder: opts.folder,
    network: opts.network,
    host: opts.host,
    numCpu: opts.numCpu !== undefined ? parsePositiveInt('--num-cpu', opts.numCpu) : undefined,
    memoryGb: opts.memoryGb !== undefined ? parsePositiveInt('--memory-gb', opts.memoryGb) : undefined,
    diskGb: opts.diskGb !== undefined ? parsePositiveInt('--disk-gb', opts.diskGb) : undefined,
    sshUser: 'sysadmin',
    sshKey: '~/.ssh/id_ed25519',
    timeoutMinutes: 10,
  };
}

/**
 * Runs the `plan` preflight end-to-end and reports progress via `ctx.output`.
 * Returns the process exit code (0 or 1) instead of calling `process.exit`
 * itself, so it stays directly unit-testable with a fake `RunFn` — the
 * pattern `znvault-plugin-webdeploy`'s command handlers already use
 * (`prepareResolvedRun`/`buildSummaryLines` in `cli/commands/run.ts`). The
 * `plan` command's `.action()` below is the one-line, untestable-in-process
 * shim that turns a non-zero result into an actual `process.exit(1)`.
 *
 * Flow (ports script lines 163-368): validate numeric options ->
 * `requireGovcEnv` -> `govc about` (connection check) -> `resolveTemplate`
 * -> `resolveTargetHost` (only issues govc calls when `--host` was given) ->
 * `validationSteps` -> `runValidations` per step, printing each step's
 * label with a checkmark/cross as it resolves -> summary.
 */
export async function runPlan(
  ctx: CLIPluginContext,
  opts: PlanOptions,
  run: RunFn = execRun,
): Promise<number> {
  let spec: VmSpec;
  try {
    spec = buildVmSpec(opts);
    requireGovcEnv(process.env);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const about = await run('govc', ['about']);
  if (about.code !== 0) {
    ctx.output.error(`Cannot connect to vCenter at ${process.env.GOVC_URL}`);
    return 1;
  }
  ctx.output.info(`Connected to ${process.env.GOVC_URL}`);

  let templatePath: string;
  try {
    templatePath = await resolveTemplate(run, spec);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  ctx.output.info(`Found template: ${templatePath}`);

  let targetHostPath: string | undefined;
  try {
    targetHostPath = await resolveTargetHost(run, spec);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const steps = validationSteps(spec, templatePath, targetHostPath);
  let failedCount = 0;
  for (const step of steps) {
    const { ok, failures } = await runValidations(run, [step]);
    if (ok) {
      ctx.output.info(`  ✓ ${step.label}`);
    } else {
      failedCount += 1;
      ctx.output.error(`  ✗ ${step.label}: ${failures[0] ?? step.failMessage}`);
    }
  }

  if (failedCount > 0) {
    ctx.output.error(`Plan validation failed: ${failedCount} of ${steps.length} check(s) failed.`);
    return 1;
  }

  ctx.output.success(`Plan validation passed (${steps.length} check(s)). Ready to create '${spec.name}'.`);
  return 0;
}

export function registerVsphereCommands(vsphere: Command, ctx: CLIPluginContext): void {
  vsphere
    .command('plan')
    .description('Preview a VM provisioning plan (read-only preflight, no vCenter changes)')
    .requiredOption('--name <name>', 'VM name (also used as hostname)')
    .requiredOption('--template <template>', 'Template name to clone from')
    .requiredOption('--datacenter <datacenter>', 'vCenter datacenter')
    .requiredOption('--cluster <cluster>', 'Target cluster')
    .requiredOption('--datastore <datastore>', 'Target datastore')
    .option('--folder <folder>', 'VM folder path')
    .option('--network <network>', 'Port group name')
    .option('--host <host>', 'Specific host in the target cluster')
    .option('--num-cpu <n>', 'Number of CPUs')
    .option('--memory-gb <n>', 'Memory in GB')
    .option('--disk-gb <n>', "Grow the template's single disk before first boot")
    .action(async (opts: PlanOptions) => {
      const code = await runPlan(ctx, opts);
      if (code !== 0) process.exit(1);
    });

  vsphere
    .command('create')
    .description('Clone and bootstrap a new VM from a template')
    .action(() => notImplemented(ctx, 'create'));

  vsphere
    .command('enroll')
    .description('Enroll a provisioned VM with zn-vault-agent')
    .action(() => notImplemented(ctx, 'enroll'));

  vsphere
    .command('status')
    .description('Report provisioning/enrollment status for a VM')
    .action(() => notImplemented(ctx, 'status'));
}
