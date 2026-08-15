// Path: src/commands.ts
// Registers the `znvault vsphere <sub>` subcommands. `plan` (Task 3) is a
// real, read-only preflight. `create` (Task 4) reuses that preflight, then
// clones/configures/powers on the VM and waits for it to come up — guarded
// by `--confirm` (see `runCreate`'s doc comment). `enroll` (Task 5, in
// `enroll.ts`) installs/configures/verifies zn-vault-agent over SSH and can
// be chained automatically from `create --fleet <hostConfig>`. `status`
// (Task 6, in `status.ts`) reports power/IP/SSH/agent state for an
// already-provisioned VM. `fence.ts` adds the two fixed LAB fence verbs.

import type { Command } from 'commander';
import type { CLIPluginContext } from './plugin-types.js';
import { execRun, type RunFn } from './run.js';
import { resolveSshKey } from './ssh-key.js';
import type { VmSpec } from './vm-spec.js';
import { bootstrapCommand, paths } from './vm-spec.js';
import { resolveTargetHost, resolveTemplate, runValidations, validationSteps } from './validate.js';
import { createPhases, makeCreateDryRun, type CreatePhase } from './create.js';
import { waitForIp, waitForSsh } from './wait.js';
import { runEnroll, type EnrollCommandOptions } from './enroll.js';
import { runStatus, type StatusOptions } from './status.js';
import { resolveVcenterRun } from './vault-credentials.js';
import { registerFenceCommands } from './fence.js';

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
  credentialAlias?: string;
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
 * Flow (ports script lines 163-368): validate numeric options -> resolve the
 * vCenter credential from ZnVault -> `govc about` -> `resolveTemplate`
 * -> `resolveTargetHost` (only issues govc calls when `--host` was given) ->
 * `validationSteps` -> `runValidations` per step, printing each step's
 * label with a checkmark/cross as it resolves -> summary.
 */
async function runPlanWithVcenter(
  ctx: CLIPluginContext,
  spec: VmSpec,
  run: RunFn,
  endpoint: string,
): Promise<number> {
  const about = await run('govc', ['about']);
  if (about.code !== 0) {
    ctx.output.error(`Cannot connect to vCenter at ${endpoint}`);
    return 1;
  }
  ctx.output.info(`Connected to ${endpoint}`);

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

export async function runPlan(
  ctx: CLIPluginContext,
  opts: PlanOptions,
  run: RunFn = execRun,
): Promise<number> {
  try {
    const spec = buildVmSpec(opts);
    const vcenter = await resolveVcenterRun(ctx, run, opts.credentialAlias);
    return await runPlanWithVcenter(ctx, spec, vcenter.run, vcenter.endpoint);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Raw `--flag <value>` strings as commander hands them to the `create`
 * action — superset of `PlanOptions` (create runs `plan`'s preflight
 * first) plus the fields the proven script's apply phase needs: static
 * network config, CA trust toggles, SSH/timeout overrides, the execution
 * guard (`--confirm`), and the fleet-enrollment chaining hook.
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
  /**
   * After a successful bootstrap, chain into `enroll` against this fleet
   * (host config) name — the same value `enroll --fleet` takes. Omitted
   * means no enrollment is attempted.
   */
  fleet?: string;
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
 * surfaced, with a concrete retry hint (`enroll --retry-bootstrap`).
 */
async function executeCreate(
  ctx: CLIPluginContext,
  spec: VmSpec,
  phases: CreatePhase[],
  run: RunFn,
  sleep: (ms: number) => Promise<void>,
  fleet: string | undefined,
  enroll: typeof runEnroll,
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

  // Chain into `enroll` when `--fleet <hostConfig>` was given — but only
  // once bootstrap actually succeeded; enrolling a VM whose bootstrap
  // (SSH-CA/PKI-CA trust, hostname, network) never completed would just
  // fail at the first SSH step for a worse-understood reason.
  let agentStatus: string;
  let enrollOk = true;
  if (fleet === undefined) {
    agentStatus = 'skipped (no --fleet)';
  } else if (!bootstrapOk) {
    agentStatus = 'skipped (bootstrap failed)';
    ctx.output.warn(
      `--fleet ${fleet} was given, but bootstrap failed — skipping enrollment. Run 'znvault vsphere enroll --fleet ${fleet} --name ${spec.name} --ip ${ip}' manually once bootstrap is fixed.`,
    );
  } else {
    ctx.output.info(`Chaining into enrollment (--fleet ${fleet})...`);
    const enrollCode = await enroll(
      ctx,
      { fleet, name: spec.name, ip, sshUser: spec.sshUser, sshKey: spec.sshKey },
      run,
    );
    enrollOk = enrollCode === 0;
    agentStatus = enrollOk ? 'enrolled' : 'enrollment failed';
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

  if (!enrollOk) {
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
 * checked first, before resolving the Vault credential or any other work —
 * a typo'd `--confirm` must never touch vCenter, not even a read-only call.
 *
 * SSH-key preflight placement (spec decision, final-review fix wave item 3):
 * `resolveSshKey` runs unconditionally at options-parse time, before Vault
 * credential resolution — not gated on `--confirm`. The costliest failure mode
 * (clone a VM, wait up to `--timeout-minutes` for SSH, then fail) only
 * happens in the guarded-execution path, but a dry-run preview is exactly
 * where an operator should learn their `--ssh-key` is misconfigured, before
 * they ever commit to a real run — so the check is not worth special-casing
 * away from preview.
 */
export async function runCreate(
  ctx: CLIPluginContext,
  opts: CreateOptions,
  run: RunFn = execRun,
  sleep: (ms: number) => Promise<void> = realSleep,
  enroll: typeof runEnroll = runEnroll,
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
    resolveSshKey(spec.sshKey);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let vcenter: Awaited<ReturnType<typeof resolveVcenterRun>>;
  try {
    vcenter = await resolveVcenterRun(ctx, run, opts.credentialAlias);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const planCode = await runPlanWithVcenter(ctx, spec, vcenter.run, vcenter.endpoint);
  if (planCode !== 0) return planCode;

  let templatePath: string;
  let targetHostPath: string | undefined;
  try {
    templatePath = await resolveTemplate(vcenter.run, spec);
    targetHostPath = await resolveTargetHost(vcenter.run, spec);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const phases = createPhases(spec, templatePath, targetHostPath, {
    sleep,
    log: (line) => ctx.output.info(line),
  });

  if (opts.confirm === undefined) {
    return previewCreate(ctx, spec, phases);
  }

  return executeCreate(ctx, spec, phases, vcenter.run, sleep, opts.fleet, enroll);
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
    .option('--credential-alias <alias>', 'ZnVault credential alias (default: infra/vsphere/leganes/vcenter)')
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
    .option('--credential-alias <alias>', 'ZnVault credential alias (default: infra/vsphere/leganes/vcenter)')
    .option('--static-ip <cidr>', 'Static IP in CIDR form, e.g. 192.0.2.30/24')
    .option('--gateway <ip>', 'Default gateway for the static IP')
    .option('--dns <servers>', 'Comma-separated DNS servers')
    .option('--skip-ssh-ca', 'Skip SSH CA trust configuration during bootstrap')
    .option('--skip-pki-ca', 'Skip PKI CA trust configuration during bootstrap')
    .option('--bootstrap-args <args>', 'Extra raw arguments passed through to bootstrap-vm.sh')
    .option('--ssh-user <user>', 'SSH user for bootstrap (default: sysadmin)')
    .option('--ssh-key <path>', 'SSH private key path for bootstrap (default: ~/.ssh/id_ed25519)')
    .option('--timeout-minutes <n>', 'Minutes to wait for IP/SSH before giving up (default: 10)')
    .option('--fleet <hostConfig>', 'After a successful bootstrap, chain into fleet enrollment against this host config')
    .option('--confirm <name>', 'Must exactly equal --name to execute; omit for a dry-run preview')
    .action(async (opts: CreateOptions) => {
      const code = await runCreate(ctx, opts);
      if (code !== 0) process.exit(1);
    });

  vsphere
    .command('enroll')
    .description('Enroll a provisioned VM with zn-vault-agent (installs, configures, and verifies the agent over SSH)')
    .requiredOption('--fleet <hostConfig>', 'Host config (fleet) to request the bootstrap token against')
    .requiredOption('--name <name>', 'VM name / agent hostname')
    .requiredOption('--ip <ip>', 'VM IP address to SSH into')
    .option('--ssh-user <user>', 'SSH user (default: sysadmin)')
    .option('--ssh-key <path>', 'SSH private key path (default: ~/.ssh/id_ed25519)')
    .option('--agent-version <version>', 'zn-vault-agent npm version to install (default: latest)')
    .option('--retry-bootstrap', 'Re-run the bootstrap-vm install script over SSH before enrolling')
    .option('--static-ip <cidr>', 'Static IP in CIDR form (only used with --retry-bootstrap)')
    .option('--gateway <ip>', 'Default gateway (only used with --retry-bootstrap)')
    .option('--dns <servers>', 'Comma-separated DNS servers (only used with --retry-bootstrap)')
    .option('--skip-ssh-ca', 'Skip SSH CA trust configuration (only used with --retry-bootstrap)')
    .option('--skip-pki-ca', 'Skip PKI CA trust configuration (only used with --retry-bootstrap)')
    .option('--bootstrap-args <args>', 'Extra raw args passed through to bootstrap-vm.sh (only used with --retry-bootstrap)')
    .action(async (opts: EnrollCommandOptions) => {
      const code = await runEnroll(ctx, opts);
      if (code !== 0) process.exit(1);
    });

  vsphere
    .command('status')
    .description('Report provisioning/enrollment status for a VM (power, IP, SSH, agent health)')
    .requiredOption('--name <name>', 'VM name')
    .option('--ssh-user <user>', 'SSH user for the reachability/agent probes (default: sysadmin)')
    .option('--ssh-key <path>', 'SSH private key path for the probes (default: ~/.ssh/id_ed25519)')
    .option('--credential-alias <alias>', 'ZnVault credential alias (default: infra/vsphere/leganes/vcenter)')
    .action(async (opts: StatusOptions) => {
      const code = await runStatus(ctx, opts);
      if (code !== 0) process.exit(1);
    });

  registerFenceCommands(vsphere, ctx);
}
