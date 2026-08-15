// Path: src/run.ts
// Process runner abstraction shared by every subcommand (Tasks 3-5): a real
// executor backed by `node:child_process` execFile, plus a dry-run variant
// that only logs what would run. Both share the RunFn contract so command
// handlers can accept either without branching on a boolean flag.

import { execFile, type ExecFileException } from 'node:child_process';

/** Outcome of a single process invocation. Never thrown — always resolved. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A runnable process invocation. Resolves (never rejects) with the process
 * outcome, including non-zero exit codes and spawn failures.
 */
export type RunFn = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<RunResult>;

/**
 * Runs `cmd` via `execFile` — never a shell, so args containing shell
 * metacharacters are passed through literally. Inherits `process.env` and
 * merges in any `opts.env` overrides. The vSphere command layer injects its
 * Vault-resolved `GOVC_*` values only for `govc` children. Never rejects: a
 * non-zero exit code or a spawn error is captured into the result.
 */
/**
 * `execFile`'s own default `maxBuffer` is 1 MiB — too small for a real
 * remote bootstrap transcript (`create`'s SSH-piped install script easily
 * exceeds it). Exceeding the default doesn't surface as a distinct error:
 * Node kills the child and `execFile` reports it as a spawn failure (a
 * non-numeric `error.code`), which `execRun` resolves as `code: -1` — the
 * exact same shape as "binary not on PATH". That misdiagnoses the plugin's
 * core create/enroll flow as an unrelated spawn problem. 64 MiB comfortably
 * covers any bootstrap/enrollment transcript this plugin produces.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export const execRun: RunFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    execFile(cmd, args, { env, maxBuffer: MAX_BUFFER_BYTES }, (error: ExecFileException | null, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout: stdout.toString(), stderr: stderr.toString() });
        return;
      }
      if (typeof error.code === 'number') {
        // The process ran and exited with a non-zero status.
        resolve({ code: error.code, stdout: stdout.toString(), stderr: stderr.toString() });
        return;
      }
      // A non-numeric `code` (e.g. 'ENOENT') means execFile could not even
      // spawn the process — not a process exit. There is no real
      // stdout/stderr from a process that never ran.
      resolve({ code: -1, stdout: '', stderr: error.message });
    });
  });

/**
 * Builds a `RunFn` that never spawns anything: it logs
 * `[dry-run] <cmd> <args…>` via `log` and resolves immediately with
 * `{ code: 0, stdout: '', stderr: '' }`. Used by `vsphere plan` and by
 * `create`/`enroll` when `--dry-run` is passed.
 */
export function makeDryRun(log: (line: string) => void): RunFn {
  return async (cmd, args) => {
    log(`[dry-run] ${[cmd, ...args].join(' ')}`);
    return { code: 0, stdout: '', stderr: '' };
  };
}
