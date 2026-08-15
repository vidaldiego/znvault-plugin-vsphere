// Path: src/status.ts
// Task 6: `vsphere status` — read-only, best-effort report of a VM's
// provisioning/enrollment state. Four signals, collected in order and each
// gated on the previous one succeeding (no IP means SSH/agent are never
// even attempted):
//   1. Power state — `govc vm.info -json <name>` (`summary.runtime.powerState`
//      per govmomi's `mo.VirtualMachine`/`VirtualMachineSummary` JSON tags).
//      An empty `virtualMachines` array (govc's own behavior for a
//      not-found VM — see `cli/vm/info.go`'s `find.NotFoundError` handling)
//      means the VM doesn't exist.
//   2. IP — best-effort `govc vm.ip -a -v4 -wait=5s <name>`; a missing IP is
//      NOT an error, just a degraded status (mirrors `wait.ts`'s
//      `waitForIp` address parsing/link-local filtering, single-shot
//      instead of polled).
//   3. SSH — a single `echo ok` probe (same shape as `wait.ts`'s
//      `waitForSsh`, no retry loop).
//   4. Agent — `curl -sf http://localhost:9100/health` run over the same
//      SSH connection (matches `enroll.ts`'s final verification step).
//
// `summarizeStatus` is the pure core (the 4 canonical combinations the task
// brief calls out); `runStatus` is the I/O orchestration + `ctx.output`
// reporting, following the same `runX` pattern as plan/create/enroll.
// `status` never gates on a degraded result — see `runStatus`'s doc
// comment — it only exits non-zero when the VM can't be found/queried at
// all.

import type { CLIPluginContext } from './plugin-types.js';
import { execRun, type RunFn } from './run.js';
import { firstAddress, LINK_LOCAL_PREFIX } from './wait.js';
import { resolveVcenterRun } from './vault-credentials.js';

/** Raw signals collected for a single VM, before summarization. */
export interface StatusInputs {
  /** `summary.runtime.powerState` from `govc vm.info -json`; `undefined` means the VM was not found. */
  powerState: string | undefined;
  /** Best-effort routable IPv4 address; `undefined` when none was reported within the wait window. */
  ip: string | undefined;
  /** Whether the `echo ok` SSH probe succeeded — meaningless when `ip` is `undefined`. */
  sshOk: boolean;
  /** Whether the agent health curl succeeded over SSH — meaningless when `sshOk` is `false`. */
  agentOk: boolean;
}

/** Human-readable status summary, one line per field, for `ctx.output`. */
export interface StatusSummary {
  power: string;
  ip: string;
  ssh: string;
  agent: string;
}

const NOT_ASSIGNED = 'not assigned';
const NOT_CHECKED_NO_IP = 'not checked (no IP)';
const NOT_CHECKED_SSH_UNREACHABLE = 'not checked (ssh unreachable)';

/**
 * Pure summarization of `StatusInputs` into a human-readable `StatusSummary`.
 * Each field degrades independently as soon as its prerequisite is missing —
 * no IP means SSH/agent were never even attempted (reported as "not checked
 * (no IP)"); SSH unreachable means the agent probe was never attempted
 * either. Covers the task brief's 4 canonical combinations: created-no-ip,
 * ip-no-ssh, ssh-no-agent, all-green.
 */
export function summarizeStatus(inputs: StatusInputs): StatusSummary {
  const power = inputs.powerState ?? 'unknown';

  if (inputs.ip === undefined) {
    return { power, ip: NOT_ASSIGNED, ssh: NOT_CHECKED_NO_IP, agent: NOT_CHECKED_NO_IP };
  }

  if (!inputs.sshOk) {
    return { power, ip: inputs.ip, ssh: 'unreachable', agent: NOT_CHECKED_SSH_UNREACHABLE };
  }

  return {
    power,
    ip: inputs.ip,
    ssh: 'reachable',
    agent: inputs.agentOk ? 'healthy' : 'unhealthy',
  };
}

/** Shape of `govc vm.info -json <name>` output (govmomi `mo.VirtualMachine`, JSON-tagged fields only). */
interface VmInfoJson {
  virtualMachines?: Array<{ summary?: { runtime?: { powerState?: string } } }>;
}

/**
 * Parses `govc vm.info -json` stdout for the first (and only, since `status`
 * queries a single name) VM's power state. Returns `undefined` both on
 * unparseable JSON and on an empty `virtualMachines` array — the latter is
 * exactly how govc itself reports "no such VM" for `vm.info` (it swallows
 * `find.NotFoundError` and returns an empty slice rather than a non-zero
 * exit — see this module's header comment).
 */
function parsePowerState(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as VmInfoJson;
    return parsed.virtualMachines?.[0]?.summary?.runtime?.powerState;
  } catch {
    return undefined;
  }
}

/**
 * Parses `govc vm.ip -a -v4 -wait=5s` stdout into a usable IP, or
 * `undefined` when none was reported. Mirrors `wait.ts`'s `waitForIp`
 * parsing: take the value before the first comma, discard link-local
 * results (no DHCP lease yet) — but single-shot, no retry loop, since
 * `status` reports a point-in-time snapshot rather than waiting for
 * provisioning to finish.
 */
function parseIp(stdout: string): string | undefined {
  const ip = firstAddress(stdout);
  if (ip === '' || ip.startsWith(LINK_LOCAL_PREFIX)) return undefined;
  return ip;
}

const DEFAULT_SSH_USER = 'sysadmin';
const DEFAULT_SSH_KEY = '~/.ssh/id_ed25519';
const AGENT_HEALTH_URL = 'http://localhost:9100/health';

/** Runs `command` over SSH against `ip`, using the same probe-style options `wait.ts`'s `waitForSsh` uses (short connect timeout, no host-key prompt). */
function sshProbe(run: RunFn, sshUser: string, sshKey: string, ip: string, command: string): ReturnType<RunFn> {
  return run('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'StrictHostKeyChecking=no',
    '-i',
    sshKey,
    `${sshUser}@${ip}`,
    command,
  ]);
}

/** Raw `--flag <value>` strings as commander hands them to the `status` action. */
export interface StatusOptions {
  name: string;
  sshUser?: string;
  sshKey?: string;
  credentialAlias?: string;
}

/**
 * Runs `status` end-to-end and reports a keyValue-style summary via
 * `ctx.output`. Returns the process exit code instead of calling
 * `process.exit` itself (same pattern as `runPlan`/`runCreate`/`runEnroll`).
 *
 * Exit semantics (spec decision, task brief): `status` **reports, it
 * doesn't gate** — a degraded result (no IP yet, SSH unreachable, agent
 * unhealthy) is a normal, successful `status` run and returns `0`. The
 * command only exits `1` when the VM itself can't be found or queried:
 * an unavailable Vault credential, a `govc vm.info` failure, or
 * an empty `virtualMachines` result (the VM doesn't exist).
 */
export async function runStatus(
  ctx: CLIPluginContext,
  opts: StatusOptions,
  run: RunFn = execRun,
): Promise<number> {
  let vcenter: Awaited<ReturnType<typeof resolveVcenterRun>>;
  try {
    vcenter = await resolveVcenterRun(ctx, run, opts.credentialAlias);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const sshUser = opts.sshUser ?? DEFAULT_SSH_USER;
  const sshKey = opts.sshKey ?? DEFAULT_SSH_KEY;

  const infoResult = await vcenter.run('govc', ['vm.info', '-json', opts.name]);
  if (infoResult.code !== 0) {
    ctx.output.error(
      `Failed to query VM status for '${opts.name}': ${infoResult.stderr || infoResult.stdout || 'no output'}`,
    );
    return 1;
  }

  const powerState = parsePowerState(infoResult.stdout);
  if (powerState === undefined) {
    ctx.output.error(`VM not found: ${opts.name}`);
    return 1;
  }

  const ipResult = await vcenter.run('govc', ['vm.ip', '-a', '-v4', '-wait=5s', opts.name]);
  const ip = ipResult.code === 0 ? parseIp(ipResult.stdout) : undefined;

  let sshOk = false;
  let agentOk = false;
  if (ip !== undefined) {
    const sshResult = await sshProbe(vcenter.run, sshUser, sshKey, ip, 'echo ok');
    sshOk = sshResult.stdout.includes('ok');

    if (sshOk) {
      const agentResult = await sshProbe(vcenter.run, sshUser, sshKey, ip, `curl -sf ${AGENT_HEALTH_URL}`);
      agentOk = agentResult.code === 0;
    }
  }

  const summary = summarizeStatus({ powerState, ip, sshOk, agentOk });

  ctx.output.info(`Status for ${opts.name}:`);
  ctx.output.info(`  Power: ${summary.power}`);
  ctx.output.info(`  IP:    ${summary.ip}`);
  ctx.output.info(`  SSH:   ${summary.ssh}`);
  ctx.output.info(`  Agent: ${summary.agent}`);

  return 0;
}
