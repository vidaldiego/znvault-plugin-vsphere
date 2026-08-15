// Path: test/wait.test.ts
// Unit tests for the injectable IP/SSH polling ported from
// `bootstrap-vm/new-bootstrapped-vm.sh`'s `wait_for_ip`/`wait_for_ssh`
// (lines 230-275). `sleep` is a fake counter — no real time ever elapses.

import { describe, it, expect } from 'vitest';
import type { RunFn, RunResult } from '../src/run.js';
import { waitForIp, waitForSsh } from '../src/wait.js';

const vmPath = '/ZincApp/vm/trust-api-1';

/** Fake sleep: resolves immediately, but records every call for assertions. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

/** Builds a RunFn that returns each canned stdout in order, one per call. */
function sequencedRun(stdouts: string[]): { run: RunFn; callCount: () => number } {
  let i = 0;
  return {
    run: async (): Promise<RunResult> => {
      const stdout = stdouts[i] ?? '';
      i += 1;
      return { code: 0, stdout, stderr: '' };
    },
    callCount: () => i,
  };
}

describe('waitForIp', () => {
  it('resolves the first non-link-local IPv4 address, discarding earlier empty/link-local polls', async () => {
    const { run, callCount } = sequencedRun(['', '169.254.1.5', '192.0.2.30,fe80::1']);
    const { sleep, calls } = fakeSleep();

    const ip = await waitForIp(run, vmPath, 60_000, sleep);

    expect(ip).toBe('192.0.2.30');
    expect(callCount()).toBe(3);
    // Sleeps between the failed polls, not after the successful one.
    expect(calls.length).toBe(2);
  });

  it('calls govc vm.ip -a -v4 -wait=1s against the VM path', async () => {
    const seen: string[][] = [];
    const run: RunFn = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, stdout: '192.0.2.30', stderr: '' };
    };
    const { sleep } = fakeSleep();

    await waitForIp(run, vmPath, 60_000, sleep);

    expect(seen).toEqual([['govc', 'vm.ip', '-a', '-v4', '-wait=1s', vmPath]]);
  });

  it('takes only the value before the first comma and trims whitespace', async () => {
    const run: RunFn = async () => ({ code: 0, stdout: '  192.0.2.31,fe80::2  \n', stderr: '' });
    const { sleep } = fakeSleep();

    await expect(waitForIp(run, vmPath, 60_000, sleep)).resolves.toBe('192.0.2.31');
  });

  it('throws on timeout when every poll is empty or link-local', async () => {
    const run: RunFn = async () => ({ code: 0, stdout: '169.254.9.9', stderr: '' });
    const { sleep, calls } = fakeSleep();

    await expect(waitForIp(run, vmPath, 10_000, sleep)).rejects.toThrow(/timeout/i);
    // 5s poll interval: two polls fit in a 10s budget before giving up.
    expect(calls.length).toBe(2);
  });

  it('treats a non-zero govc exit (vm.ip -wait races the guest tools) as "no IP yet", not a hard failure', async () => {
    let calls = 0;
    const run: RunFn = async () => {
      calls += 1;
      if (calls === 1) return { code: 1, stdout: '', stderr: 'guest tools not ready' };
      return { code: 0, stdout: '192.0.2.32', stderr: '' };
    };
    const { sleep } = fakeSleep();

    await expect(waitForIp(run, vmPath, 60_000, sleep)).resolves.toBe('192.0.2.32');
    expect(calls).toBe(2);
  });
});

describe('waitForSsh', () => {
  const user = 'sysadmin';
  const key = '/home/x/.ssh/id_ed25519';
  const host = '192.0.2.30';

  it('resolves once the probe stdout contains "ok"', async () => {
    const { run, callCount } = sequencedRun(['', '', 'ok\n']);
    const { sleep, calls } = fakeSleep();

    await expect(waitForSsh(run, user, key, host, 60_000, sleep)).resolves.toBeUndefined();
    expect(callCount()).toBe(3);
    expect(calls.length).toBe(2);
  });

  it('runs the exact ssh probe command from the proven script', async () => {
    const seen: string[][] = [];
    const run: RunFn = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const { sleep } = fakeSleep();

    await waitForSsh(run, user, key, host, 60_000, sleep);

    expect(seen).toEqual([
      [
        'ssh',
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
      ],
    ]);
  });

  it('throws on timeout when the probe never succeeds', async () => {
    const run: RunFn = async () => ({ code: 255, stdout: '', stderr: 'Connection refused' });
    const { sleep, calls } = fakeSleep();

    await expect(waitForSsh(run, user, key, host, 10_000, sleep)).rejects.toThrow(/timeout/i);
    expect(calls.length).toBe(2);
  });
});
