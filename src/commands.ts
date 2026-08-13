// Path: src/commands.ts
// Registers the `znvault vsphere <sub>` subcommands. `plan` (Task 3) is a
// real, read-only preflight. `create` (Task 4) reuses that preflight, then
// clones/configures/powers on the VM and waits for it to come up — guarded
// by `--confirm` (see `runCreate`'s doc comment). `enroll`/`status` remain
// stubs for Task 5.

import type { Command } from 'commander';
import type { CLIPluginContext } from './plugin-types.js';
import { execRun, requireGovcEnv, type RunFn } from './run.js';
import type { VmSpec } from './vm-spec.js';
import { bootstrapCommand, paths } from './vm-spec.js';
import { resolveTargetHost, resolveTemplate, runValidations, validationSteps } from './validate.js';
import { createPhases, makeCreateDryRun, type CreatePhase } from './create.js';
import { waitForIp, waitForSsh } from './wait.js';

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

/**
 * Raw `--flag <value>` strings as commander hands them to the `create`
 * action — superset of `PlanOptions` (create runs `plan`'s preflight
 * first) plus the fields the proven script's apply phase needs: static
 * network config, CA trust toggles, SSH/timeout overrides, the execution
 * guard (`--confirm`), and the Task-5 fleet-enrollment hook.
 */
export interface CreateOptions extends PlanOptions {
  staticIp?: string;
  gateway?: string;
  dns?: string;
  /**
   * CLI flags are `--skip-ssh-ca`/`--skip-pki-ca`, not the script's own
   * `--no-ssh-ca`/`--no-pki-ca`: Commander auto-negates any `--no-x` option
   * name into a boolean `x` that defaults `true`, which would collide with
   * `VmSpec.noSshCa`/`noPkiCa`'s "true means skip" meaning. `--skip-*`
   * avoids that trap entirely; `buildCreateVmSpec` maps it onto the
   * `VmSpec` fields `bootstrapCommand` (vm-spec.ts) actually reads.
   */
  skipSshCa?: boolean;
  skipPkiCa?: boolean;
  bootstrapArgs?: string;
  sshUser?: string;
  sshKey?: string;
  timeoutMinutes?: string;
  /** After a successful bootstrap, chain into Task 5's fleet enrollment (TODO — not implemented yet). */
  fleet?: boolean;
  /** Must equal `--name` exactly to execute; omitted means dry-run preview only. */
  confirm?: string;
}

/**
 * Builds the full `VmSpec` `create` needs — `buildVmSpec`'s plan-only spec
 * plus the fields `plan` never touches: `sshUser`/`sshKey`/`timeoutMinutes`
 * (script defaults `sysadmin`/`~/.ssh/id_ed25519`/10 when not overridden)
 * and the bootstrap-time static-network/CA-trust/passthrough options
 * `bootstrapCommand` consumes.
 */
function buildCreateVmSpec(opts: CreateOptions): VmSpec {
  return {
    ...buildVmSpec(opts),
    sshUser: opts.sshUser ?? 'sysadmin',
    sshKey: opts.sshKey ?? '~/.ssh/id_ed25519',
    timeoutMinutes:
      opts.timeoutMinutes !== undefined ? parsePositiveInt('--timeout-minutes', opts.timeoutMinutes) : 10,
    staticIp: opts.staticIp,
    gateway: opts.gateway,
    dns: opts.dns,
    noSshCa: opts.skipSshCa,
    noPkiCa: opts.skipPkiCa,
    bootstrapArgs: opts.bootstrapArgs,
  };
}

/** Real (non-injected) sleep, used by `runCreate`'s default `sleep` dependency. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shows what `create` would do without touching vCenter: previews every
 * mutation phase via `makeCreateDryRun` (so the exact govc argv is printed,
 * including the fabricated grow-disk resize) plus the wait/bootstrap steps
 * that only exist once a VM is actually running. This is the **default**
 * behavior when `--confirm` is omitted — a spec decision, not a bug: an
 * operator must pass `--confirm <name>` to actually mutate vCenter.
 */
async function previewCreate(ctx: CLIPluginContext, spec: VmSpec, phases: CreatePhase[]): Promise<number> {
  const dryRun = makeCreateDryRun((line) => ctx.output.info(line));

  for (const phase of phases) {
    ctx.output.info(`[plan] ${phase.label}`);
    await phase.exec(dryRun);
  }

  ctx.output.info(`[plan] wait-for-ip (timeout ${spec.timeoutMinutes}min)`);
  ctx.output.info(`[plan] wait-for-ssh (timeout ${spec.timeoutMinutes}min)`);
  await dryRun('ssh', [
    '-o',
    'StrictHostKeyChecking=no',
    '-i',
    spec.sshKey,
    `${spec.sshUser}@<vm-ip>`,
    bootstrapCommand(spec),
  ]);

  ctx.output.success(`Dry run complete; no VM was created. Re-run with --confirm ${spec.name} to create it.`);
  return 0;
}

/**
 * Runs `create`'s mutation phases for real, then waits for IP/SSH and runs
 * the bootstrap command over SSH. Ports the proven script's apply phase
 * (lines 395-538), with one deliberate fix: the script captured the ssh
 * bootstrap's exit code into `EXIT_CODE=$?` but that line was dead code
 * under `set -e` (a non-zero `ssh` exit trips `set -e` and exits the whole
 * script *before* `EXIT_CODE` is ever read) — so a failed bootstrap was
 * reported as generic script failure with no distinct "VM created but
 * bootstrap failed" outcome. Here the exit code is captured and always
 * surfaced, with a concrete retry hint (`enroll --retry-bootstrap`, Task 5).
 */
async function executeCreate(
  ctx: CLIPluginContext,
  spec: VmSpec,
  phases: CreatePhase[],
  run: RunFn,
  sleep: (ms: number) => Promise<void>,
  fleet: boolean | undefined,
): Promise<number> {
  const p = paths(spec);

  for (const phase of phases) {
    ctx.output.info(`Phase: ${phase.label}`);
    try {
      await phase.exec(run);
    } catch (error) {
      ctx.output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  ctx.output.success(`VM created: ${spec.name}`);

  const timeoutMs = spec.timeoutMinutes * 60_000;

  let ip: string;
  try {
    ip = await waitForIp(run, p.vm, timeoutMs, sleep);
  } catch {
    ctx.output.error('Timeout waiting for VM IP address');
    ctx.output.info('VM created but bootstrap not run. Check VM console.');
    return 1;
  }
  ctx.output.success(`VM IP: ${ip}`);

  try {
    await waitForSsh(run, spec.sshUser, spec.sshKey, ip, timeoutMs, sleep);
  } catch {
    ctx.output.error('Timeout waiting for SSH');
    ctx.output.info(`VM created but bootstrap not run. Connect manually: ssh ${spec.sshUser}@${ip}`);
    return 1;
  }
  ctx.output.success('SSH is available');

  const bootstrapCmd = bootstrapCommand(spec);
  ctx.output.info(`Running bootstrap: ${bootstrapCmd}`);
  const bootstrapResult = await run('ssh', [
    '-o',
    'StrictHostKeyChecking=no',
    '-i',
    spec.sshKey,
    `${spec.sshUser}@${ip}`,
    bootstrapCmd,
  ]);
  const bootstrapOk = bootstrapResult.code === 0;

  if (bootstrapOk) {
    ctx.output.success('Bootstrap complete!');
  } else {
    ctx.output.error(`Bootstrap exited with code ${bootstrapResult.code}`);
  }

  // TODO(Task 5): once the fleet-enrollment module exists, chain into it
  // here when `--fleet` was given, and fold its ok/fail into the summary
  // below instead of just pointing at the manual command.
  let agentStatus = 'skipped (no --fleet)';
  if (fleet) {
    agentStatus = 'not attempted — fleet enrollment is not implemented yet (Task 5)';
    ctx.output.warn("--fleet was given, but fleet enrollment isn't implemented yet. Run 'znvault vsphere enroll' manually once it lands.");
  }

  ctx.output.info('Summary:');
  ctx.output.info(`  Name: ${spec.name}`);
  ctx.output.info(`  IP: ${ip}`);
  ctx.output.info(`  Bootstrap: ${bootstrapOk ? 'ok' : 'failed'}`);
  ctx.output.info(`  Agent: ${agentStatus}`);

  if (!bootstrapOk) {
    ctx.output.info('Retry bootstrap with: znvault vsphere enroll --retry-bootstrap');
    return 1;
  }

  return 0;
}

/**
 * Runs `create` end-to-end: `--confirm` guard -> build spec -> `runPlan`
 * (reused verbatim, not duplicated) -> resolve template/host again for the
 * mutation phases (cheap, idempotent reads) -> either preview (no
 * `--confirm`) or execute for real.
 *
 * Guard semantics (spec decision): omitting `--confirm` is a **dry-run by
 * default** — `create` still runs the full read-only `plan` preflight
 * against real vCenter, then only *previews* the mutation phases. Passing
 * `--confirm <value>` that does not equal `--name` exactly is an error,
 * checked first, before `requireGovcEnv` or any other work — a typo'd
 * `--confirm` must never touch vCenter, not even a read-only call.
 */
export async function runCreate(
  ctx: CLIPluginContext,
  opts: CreateOptions,
  run: RunFn = execRun,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<number> {
  if (opts.confirm !== undefined && opts.confirm !== opts.name) {
    ctx.output.error(
      `--confirm '${opts.confirm}' does not match --name '${opts.name}'. Aborting before any change.`,
    );
    return 1;
  }

  let spec: VmSpec;
  try {
    spec = buildCreateVmSpec(opts);
    requireGovcEnv(process.env);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const planCode = await runPlan(ctx, opts, run);
  if (planCode !== 0) return planCode;

  let templatePath: string;
  let targetHostPath: string | undefined;
  try {
    templatePath = await resolveTemplate(run, spec);
    targetHostPath = await resolveTargetHost(run, spec);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const phases = createPhases(spec, templatePath, targetHostPath, { sleep });

  if (opts.confirm === undefined) {
    return previewCreate(ctx, spec, phases);
  }

  return executeCreate(ctx, spec, phases, run, sleep, opts.fleet);
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
    .description(
      'Clone and bootstrap a new VM from a template (dry-run preview by default; pass --confirm <name> to execute)',
    )
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
    .option('--static-ip <cidr>', 'Static IP in CIDR form, e.g. 172.16.211.30/24')
    .option('--gateway <ip>', 'Default gateway for the static IP')
    .option('--dns <servers>', 'Comma-separated DNS servers')
    .option('--skip-ssh-ca', 'Skip SSH CA trust configuration during bootstrap')
    .option('--skip-pki-ca', 'Skip PKI CA trust configuration during bootstrap')
    .option('--bootstrap-args <args>', 'Extra raw arguments passed through to bootstrap-vm.sh')
    .option('--ssh-user <user>', 'SSH user for bootstrap (default: sysadmin)')
    .option('--ssh-key <path>', 'SSH private key path for bootstrap (default: ~/.ssh/id_ed25519)')
    .option('--timeout-minutes <n>', 'Minutes to wait for IP/SSH before giving up (default: 10)')
    .option('--fleet', 'After a successful bootstrap, chain into fleet enrollment (Task 5 — not yet implemented)')
    .option('--confirm <name>', 'Must exactly equal --name to execute; omit for a dry-run preview')
    .action(async (opts: CreateOptions) => {
      const code = await runCreate(ctx, opts);
      if (code !== 0) process.exit(1);
    });

  vsphere
    .command('enroll')
    .description('Enroll a provisioned VM with zn-vault-agent')
    .action(() => notImplemented(ctx, 'enroll'));

  vsphere
    .command('status')
    .description('Report provisioning/enrollment status for a VM')
    .action(() => notImplemented(ctx, 'status'));
}
