// Path: src/wait.ts
// Injectable polling for VM IP acquisition and SSH availability — ports
// `bootstrap-vm/new-bootstrapped-vm.sh`'s `wait_for_ip`/`wait_for_ssh`
// (lines 230-275). `sleep` is injected so callers (tests) never wait in
// real time; production wiring passes a real `setTimeout`-backed sleep.

import type { RunFn } from './run.js';

/** Mirrors the script's `interval=5` (seconds) between polls. */
const POLL_INTERVAL_MS = 5_000;

/** Exported for reuse by `status.ts`'s best-effort single-shot IP check. */
export const LINK_LOCAL_PREFIX = '169.254.';

/**
 * `"192.0.2.30,fe80::1"` -> `"192.0.2.30"` — mirrors `ip="${ip%%,*}"`.
 * Exported for reuse by `status.ts`'s best-effort single-shot IP check (same
 * `govc vm.ip -a -v4` multi-address stdout shape, just a single poll instead
 * of a wait loop).
 */
export function firstAddress(stdout: string): string {
  return (stdout.split(',')[0] ?? '').trim();
}

/**
 * Polls `govc vm.ip -a -v4 -wait=1s <vmPath>` until it returns a routable
 * IPv4 address. Mirrors `wait_for_ip` (script lines 230-255): takes the
 * value before the first comma (govc can report multiple addresses),
 * discards link-local results (`169.254.*` — no DHCP lease yet), and
 * retries every `POLL_INTERVAL_MS` until `timeoutMs` elapses. A non-zero
 * `govc` exit (e.g. guest tools not ready yet) is treated the same as an
 * empty/link-local result — not a hard failure — matching the script's
 * `govc vm.ip ... 2>/dev/null || true`.
 */
export async function waitForIp(
  run: RunFn,
  vmPath: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  let elapsedMs = 0;

  while (elapsedMs < timeoutMs) {
    const result = await run('govc', ['vm.ip', '-a', '-v4', '-wait=1s', vmPath]);
    const ip = result.code === 0 ? firstAddress(result.stdout) : '';

    if (ip !== '' && !ip.startsWith(LINK_LOCAL_PREFIX)) {
      return ip;
    }

    await sleep(POLL_INTERVAL_MS);
    elapsedMs += POLL_INTERVAL_MS;
  }

  throw new Error(`Timeout waiting for VM IP address (${vmPath})`);
}

/**
 * Polls an SSH probe until the guest is reachable. Mirrors `wait_for_ssh`
 * (script lines 257-275): `ssh -o BatchMode=yes -o ConnectTimeout=5 -o
 * StrictHostKeyChecking=no -i <key> <user>@<host> "echo ok"`, retried every
 * `POLL_INTERVAL_MS` until `timeoutMs` elapses, succeeding once stdout
 * contains `"ok"` (mirrors the script's `| grep -q "ok"`).
 */
export async function waitForSsh(
  ssh: RunFn,
  user: string,
  key: string,
  host: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let elapsedMs = 0;

  while (elapsedMs < timeoutMs) {
    const result = await ssh('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=no',
      '-i',
      key,
      `${user}@${host}`,
      'echo ok',
    ]);

    if (result.stdout.includes('ok')) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
    elapsedMs += POLL_INTERVAL_MS;
  }

  throw new Error(`Timeout waiting for SSH (${user}@${host})`);
}
