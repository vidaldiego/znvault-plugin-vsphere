// Path: src/enroll.ts
// Task 5: `vsphere enroll` — enrolls a provisioned VM with zn-vault-agent.
// Encodes the 6-step flow + 4 gotchas from
// archon-node/docs/runbooks/ZN_VAULT_AGENT_ENROLLMENT.md as 8 sequential SSH
// commands (`enrollScript`), fronted by a real bootstrap-token request
// (`requestToken`) against the endpoint's known-correct contract
// (`expiresInSeconds`, NEVER `expiresAt` — that field name is a known bug in
// the built-in CLI's `--expires` flag, silently ignored by the server).
//
// Token hygiene: `enrollScript`'s step 4 (login) is the ONLY place the raw
// token is embedded in a command string — that string is handed straight to
// `run`/ssh and is NEVER passed to `ctx.output.*`. Anything logged about the
// token goes through `redactToken` first.

import type { CLIPluginContext } from './plugin-types.js';
import { execRun, type RunFn, type RunResult } from './run.js';
import { resolveSshKey } from './ssh-key.js';
import type { VmSpec } from './vm-spec.js';
import { bootstrapCommand } from './vm-spec.js';

/** Resolved enrollment parameters (defaults already applied) driving `enrollScript` + the SSH transport. */
export interface EnrollOpts {
  fleet: string;
  hostname: string;
  ip: string;
  sshUser: string;
  sshKey: string;
  agentVersion?: string;
}

/** Response shape of `POST /v1/hosts/<fleet>/bootstrap-token`. */
export interface BootstrapTokenResponse {
  token: string;
  expiresAt: string;
  bootstrapUrl: string;
  hostConfigId: string;
  hostname: string;
  agentHostname: string;
}

const BOOTSTRAP_TOKEN_TTL_SECONDS = 3_600;

/**
 * Requests a one-time bootstrap token for `agentHostname` against `fleet`'s
 * host config. Body is `{ agentHostname, expiresInSeconds }` — deliberately
 * NOT `expiresAt`, which is what the built-in `znvault` CLI's `--expires`
 * flag sends and the server silently ignores (known bug); this plugin talks
 * to the endpoint directly so it must get the field name right.
 */
export function requestToken(
  client: { post<T>(path: string, body: unknown): Promise<T> },
  fleet: string,
  agentHostname: string,
): Promise<BootstrapTokenResponse> {
  return client.post<BootstrapTokenResponse>(`/v1/hosts/${fleet}/bootstrap-token`, {
    agentHostname,
    expiresInSeconds: BOOTSTRAP_TOKEN_TTL_SECONDS,
  });
}

/** Human-readable label for each `enrollScript` step, in the same order — used for per-step progress/failure reporting. */
export const ENROLL_STEP_LABELS: readonly string[] = [
  'install agent package',
  'fix bin symlink (gotcha: npm bin symlink)',
  'setup agent infra (user/group/dirs/systemd unit)',
  'login with bootstrap token',
  'fix config ownership (gotcha: config.json root-owned)',
  'add RuntimeDirectory drop-in (gotcha: missing RuntimeDirectory)',
  'restart agent service',
  'verify health (systemctl is-active + curl /health)',
];

/** Where npm installs the agent's real entrypoint — the auto-created `/usr/bin` symlink can point at a nonexistent `bin/zn-vault-agent` instead of this, hence gotcha 1. */
const AGENT_ENTRYPOINT = '/usr/lib/node_modules/@zincapp/zn-vault-agent/dist/index.js';

const AGENT_HEALTH_URL = 'http://localhost:9100/health';

/**
 * Builds the 8 ordered remote commands that enroll zn-vault-agent on a
 * freshly-provisioned node, encoding the runbook's 4 gotchas:
 *
 * 1. Install the npm package (pinned version, or `latest`).
 * 2. **Gotcha 1** — fix both `/usr/bin` and `/usr/local/bin` symlinks to the
 *    package's real entrypoint (the systemd unit's `ExecStart` uses
 *    `/usr/local/bin`), then verify with `--version`.
 * 3. Run `setup -y` (creates the `zn-vault-agent` user/group, config/data
 *    dirs, and the systemd unit).
 * 4. `login` with the bootstrap token — the ONLY step embedding the raw
 *    token.
 * 5. **Gotcha 2** — `login` runs as root, so `chown` the config/data dirs
 *    back to the `zn-vault-agent` service user (else `EACCES` crash-loop).
 * 6. **Gotcha 3** — the installed unit has no `RuntimeDirectory=`, so
 *    `/run/zn-vault-agent` is never auto-created; add a systemd drop-in and
 *    reload.
 * 7. Restart the service so the drop-in and fresh config both take effect.
 * 8. Verify: `systemctl is-active` plus a local health-endpoint curl —
 *    stdout from this step is safe to echo back to the operator in full.
 */
export function enrollScript(vaultUrl: string, token: string, hostname: string, agentVersion?: string): string[] {
  const version = agentVersion ?? 'latest';
  return [
    `sudo npm install -g @zincapp/zn-vault-agent@${version}`,
    `sudo ln -sf ${AGENT_ENTRYPOINT} /usr/bin/zn-vault-agent && sudo ln -sf ${AGENT_ENTRYPOINT} /usr/local/bin/zn-vault-agent && zn-vault-agent --version`,
    'sudo zn-vault-agent setup -y',
    `sudo zn-vault-agent login --url ${vaultUrl} --bootstrap-token ${token} --host-name ${hostname}`,
    'sudo chown -R zn-vault-agent:zn-vault-agent /etc/zn-vault-agent /var/lib/zn-vault-agent',
    // The drop-in directory does not exist on a fresh node — tee cannot create
    // parent dirs (found live on trust-api-1, 2026-08-13; the runbook's node
    // happened to have the directory already).
    "sudo mkdir -p /etc/systemd/system/zn-vault-agent.service.d && printf '[Service]\\nRuntimeDirectory=zn-vault-agent\\nRuntimeDirectoryMode=0755\\n' | sudo tee /etc/systemd/system/zn-vault-agent.service.d/runtime-dir.conf >/dev/null && sudo systemctl daemon-reload",
    'sudo systemctl restart zn-vault-agent',
    `sudo systemctl is-active zn-vault-agent && curl -sf ${AGENT_HEALTH_URL}`,
  ];
}

const TOKEN_PREFIX = 'zrt_';
const REDACTED_VISIBLE_CHARS = 8;

/**
 * Reduces a bootstrap token to a safe-to-log form: `zrt_` followed by the
 * first 8 characters of the token body and an ellipsis — never the full
 * token. Used for every log line that needs to reference the token (e.g.
 * "token acquired"); `enrollScript`'s step 4 is the only place the raw token
 * itself is ever assembled, and that string only ever reaches `run`/ssh, not
 * `ctx.output`.
 */
export function redactToken(token: string): string {
  const body = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : token;
  return `${TOKEN_PREFIX}${body.slice(0, REDACTED_VISIBLE_CHARS)}…`;
}

/**
 * Runs `command` over SSH against `opts.ip` using `opts.sshUser`/`opts.sshKey`
 * — the same `-o StrictHostKeyChecking=no -i <key> <user>@<ip> "<command>"`
 * shape `create`'s bootstrap step and `wait.ts`'s SSH probe already use.
 */
export function sshRun(run: RunFn, opts: EnrollOpts, command: string): Promise<RunResult> {
  return run('ssh', ['-o', 'StrictHostKeyChecking=no', '-i', opts.sshKey, `${opts.sshUser}@${opts.ip}`, command]);
}

/** Default SSH user/key, matching `vm-spec.ts`'s script-derived defaults. */
const DEFAULT_SSH_USER = 'sysadmin';
const DEFAULT_SSH_KEY = '~/.ssh/id_ed25519';

/**
 * Raw `--flag <value>` strings as commander hands them to the `enroll`
 * action. `--fleet`/`--name`/`--ip` are required; SSH options fall back to
 * the same defaults `create` uses. The static-network/CA-skip/passthrough
 * fields are only consulted when `--retry-bootstrap` is given.
 */
export interface EnrollCommandOptions {
  fleet: string;
  name: string;
  ip: string;
  sshUser?: string;
  sshKey?: string;
  agentVersion?: string;
  /** Re-run the bootstrap-vm install script over SSH before enrolling. */
  retryBootstrap?: boolean;
  staticIp?: string;
  gateway?: string;
  dns?: string;
  skipSshCa?: boolean;
  skipPkiCa?: boolean;
  bootstrapArgs?: string;
}

/** Resolves `EnrollCommandOptions` into the `EnrollOpts` the rest of this module consumes, applying SSH defaults. */
export function buildEnrollOpts(opts: EnrollCommandOptions): EnrollOpts {
  return {
    fleet: opts.fleet,
    hostname: opts.name,
    ip: opts.ip,
    sshUser: opts.sshUser ?? DEFAULT_SSH_USER,
    sshKey: opts.sshKey ?? DEFAULT_SSH_KEY,
    agentVersion: opts.agentVersion,
  };
}

/**
 * Fields `bootstrapCommand` (vm-spec.ts) never reads: `template`,
 * `datacenter`, `cluster`, `datastore` are part of `VmSpec` only because
 * `plan`/`create` need them for govc calls this command never makes.
 * `enroll --retry-bootstrap` only needs the SSH-side rendering of the
 * bootstrap command line, so those fields are filled with an inert
 * placeholder rather than exporting `create.ts`'s `buildCreateVmSpec` (which
 * needs the full plan/create option surface `enroll` doesn't collect). If
 * `bootstrapCommand` is ever changed to read one of these, search for this
 * constant.
 */
const PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND = '';

/** Builds the minimal `VmSpec` needed to re-render `bootstrapCommand` for `--retry-bootstrap`. See `PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND`. */
function buildRetryBootstrapSpec(opts: EnrollCommandOptions, enrollOpts: EnrollOpts): VmSpec {
  return {
    name: enrollOpts.hostname,
    template: PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND,
    datacenter: PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND,
    cluster: PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND,
    datastore: PLACEHOLDER_UNUSED_BY_BOOTSTRAP_COMMAND,
    sshUser: enrollOpts.sshUser,
    sshKey: enrollOpts.sshKey,
    timeoutMinutes: 10,
    staticIp: opts.staticIp,
    gateway: opts.gateway,
    dns: opts.dns,
    noSshCa: opts.skipSshCa,
    noPkiCa: opts.skipPkiCa,
    bootstrapArgs: opts.bootstrapArgs,
  };
}

/**
 * Runs `enroll` end-to-end and reports progress via `ctx.output`. Returns
 * the process exit code instead of calling `process.exit` itself (same
 * pattern as `runPlan`/`runCreate`) — the `enroll` command's `.action()` is
 * the thin, untestable-in-process shim that turns a non-zero result into a
 * real `process.exit(1)`.
 *
 * Flow: resolve/validate `--ssh-key` (final-review fix wave item 3 — fails
 * fast with a clear error before any SSH or token-request work, rather than
 * discovering a missing key only when the first `ssh` invocation fails) ->
 * optionally retry the bootstrap-vm install over SSH (`--retry-bootstrap`,
 * stops here on failure, never requests a token) -> request a bootstrap
 * token via `ctx.client` -> run `enrollScript`'s 8 steps sequentially over
 * SSH, logging only the step label (never the raw command, which for step 4
 * contains the token) -> stop at the first failing step, reporting its label
 * and stderr -> on success, echo the final verification step's stdout.
 */
export async function runEnroll(
  ctx: CLIPluginContext,
  opts: EnrollCommandOptions,
  run: RunFn = execRun,
): Promise<number> {
  const enrollOpts = buildEnrollOpts(opts);

  try {
    resolveSshKey(enrollOpts.sshKey);
  } catch (error) {
    ctx.output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (opts.retryBootstrap) {
    ctx.output.info('Retrying bootstrap before enrollment...');
    const spec = buildRetryBootstrapSpec(opts, enrollOpts);
    const result = await sshRun(run, enrollOpts, bootstrapCommand(spec));
    if (result.code !== 0) {
      ctx.output.error(
        `Bootstrap retry failed (exit ${result.code}): ${result.stderr || result.stdout || 'no output'}`,
      );
      return 1;
    }
    ctx.output.success('Bootstrap retry complete.');
  }

  let tokenResponse: BootstrapTokenResponse;
  try {
    tokenResponse = await requestToken(ctx.client, enrollOpts.fleet, enrollOpts.hostname);
  } catch (error) {
    ctx.output.error(`Failed to request bootstrap token: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  ctx.output.info(`Bootstrap token acquired: ${redactToken(tokenResponse.token)}`);

  const vaultUrl = ctx.getConfig().url;
  const steps = enrollScript(vaultUrl, tokenResponse.token, enrollOpts.hostname, enrollOpts.agentVersion);

  for (let i = 0; i < steps.length; i += 1) {
    const command = steps[i];
    if (command === undefined) continue; // unreachable: i < steps.length
    const label = ENROLL_STEP_LABELS[i] ?? `step ${i + 1}`;
    ctx.output.info(`[${i + 1}/${steps.length}] ${label}`);

    const result = await sshRun(run, enrollOpts, command);
    if (result.code !== 0) {
      ctx.output.error(`Step failed: ${label} (exit ${result.code}): ${result.stderr || result.stdout || 'no output'}`);
      return 1;
    }

    if (i === steps.length - 1 && result.stdout.trim() !== '') {
      ctx.output.info(result.stdout.trim());
    }
  }

  ctx.output.success(`zn-vault-agent enrolled on ${enrollOpts.hostname} (${enrollOpts.ip})`);
  return 0;
}
