// Path: src/ssh-key.ts
// SSH-key existence preflight (final-review fix wave, Item 3): the proven
// `new-bootstrapped-vm.sh` script fails fast when the configured SSH key is
// missing. This plugin previously had no equivalent check — `create` would
// clone the VM, power it on, and poll for up to the full `--timeout-minutes`
// (10min default) waiting for SSH to come up, only to fail at the very last
// step because `ssh -i <missing-key>` could never have worked in the first
// place. `enroll` had the same gap on its own SSH steps. Checking the key
// exists before any of that work starts turns a 10-minute timeout into an
// instant, unambiguous error.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Resolves `path`, expanding a single leading `~` to `os.homedir()` (the
 * same convention every `~/.ssh/...` default in this package already
 * relies on — see `vm-spec.ts`, `enroll.ts`, `status.ts`), then verifies the
 * resolved path exists via `statSync`.
 *
 * Returns the expanded path on success. Throws a clear, actionable
 * `Error('SSH key not found: <expanded path>')` when the file is missing or
 * otherwise unreachable (e.g. `statSync` failing on a dangling symlink or a
 * permissions error) — the expanded path is named explicitly so the operator
 * sees exactly where the plugin looked, not the raw `~`-form they typed.
 */
export function resolveSshKey(path: string): string {
  const expanded = path.startsWith('~') ? homedir() + path.slice(1) : path;
  try {
    statSync(expanded);
  } catch {
    throw new Error(`SSH key not found: ${expanded}`);
  }
  return expanded;
}
