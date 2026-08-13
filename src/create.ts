// Path: src/create.ts
// Builds the ordered list of mutating govc phases `vsphere create` runs
// after `plan`'s read-only preflight passes — ports
// `bootstrap-vm/new-bootstrapped-vm.sh` lines 395-461: clone (395-415),
// resize (418-433), grow-disk (437-449, re-reading the CLONE's own disk
// info — not the template's — and only resizing when the requested size is
// strictly greater than the clone's current size, matching the script's
// `(( DISK_GB > TEMPLATE_DISK_GB ))` guard at line 437), network (452-456),
// power-on (459-461). Waiting for IP/SSH and running the bootstrap command
// are orchestrated by the `create` handler in `commands.ts` (see
// `wait.ts`), not here — this module only builds the govc mutation phases.

import { makeDryRun, type RunFn } from './run.js';
import type { VmSpec } from './vm-spec.js';
import { cloneArgs, paths } from './vm-spec.js';
import { BYTES_PER_GB, parseDiskDevicesJson } from './validate.js';

/**
 * vCenter's inventory can lag briefly right after `vm.clone` returns —
 * every phase after `clone` reads or mutates the freshly created VM object
 * (`grow-disk` in particular re-reads its `device.info` from scratch). This
 * is a short settle delay, not a real wait loop (see `wait.ts` for the
 * actual IP/SSH polling with its own timeout) — it exists purely to reduce
 * the odds of a stale-inventory race, and is threaded through `deps.sleep`
 * so tests can assert it happens without a real delay.
 */
const CLONE_SETTLE_MS = 2_000;

/** One step of `create`'s execution plan: a human label plus its govc work. */
export interface CreatePhase {
  label: string;
  exec: (run: RunFn) => Promise<void>;
}

function throwOnFailure(action: string, code: number, stderr: string, stdout: string): never {
  throw new Error(`${action} failed (exit ${code}): ${stderr || stdout || 'no output'}`);
}

/**
 * Builds the ordered mutation phases for a spec. Always includes `clone`
 * and `power-on`; `resize` is included when `--num-cpu` and/or
 * `--memory-gb` was given, `grow-disk` when `--disk-gb` was given, and
 * `network` when `--network` was given — mirroring the script's own `if
 * [[ -n ... ]]` guards around each block.
 */
export function createPhases(
  s: VmSpec,
  templatePath: string,
  targetHostPath: string | undefined,
  deps: { sleep: (ms: number) => Promise<void>; log?: (line: string) => void },
): CreatePhase[] {
  const p = paths(s);
  const phases: CreatePhase[] = [];

  phases.push({
    label: 'clone',
    exec: async (run) => {
      const result = await run('govc', cloneArgs(s, templatePath, targetHostPath));
      if (result.code !== 0) throwOnFailure('govc vm.clone', result.code, result.stderr, result.stdout);
      await deps.sleep(CLONE_SETTLE_MS);
    },
  });

  if (s.numCpu !== undefined || s.memoryGb !== undefined) {
    phases.push({
      label: 'resize',
      exec: async (run) => {
        const args = ['vm.change', '-vm', p.vm];
        if (s.numCpu !== undefined) args.push('-c', String(s.numCpu));
        if (s.memoryGb !== undefined) args.push('-m', String(s.memoryGb * 1024));

        const result = await run('govc', args);
        if (result.code !== 0) throwOnFailure('govc vm.change', result.code, result.stderr, result.stdout);
      },
    });
  }

  if (s.diskGb !== undefined) {
    const requestedGb = s.diskGb;
    phases.push({
      label: 'grow-disk',
      exec: async (run) => {
        const info = await run('govc', ['device.info', '-json', '-vm', p.vm, 'disk-*']);
        if (info.code !== 0) {
          throw new Error(`Failed to inspect cloned VM disk(s): ${p.vm}`);
        }

        const devices = parseDiskDevicesJson(info.stdout);
        if (devices === null) {
          throw new Error(`Failed to parse disk info for cloned VM: ${p.vm}`);
        }
        if (devices.length !== 1) {
          throw new Error(`Cloned VM has ${devices.length} disks; refusing an ambiguous resize`);
        }

        const disk = devices[0];
        if (disk === undefined) {
          throw new Error(`Cloned VM's disk info is empty: ${p.vm}`);
        }

        const diskKey = disk.key;
        if (diskKey === undefined) {
          throw new Error(`Cloned VM's disk is missing a device key: ${p.vm}`);
        }

        // Mirrors the script's `(( DISK_GB > TEMPLATE_DISK_GB ))` guard
        // (line 437) — re-read against the CLONE's own current size (not
        // the template's, which `plan`'s precheck already validated): only
        // grow when the requested size is strictly greater than what the
        // clone already has. `plan`'s precheck allows `--disk-gb` equal to
        // the template's size, so this is the authoritative gate against an
        // untested, unnecessary same/smaller-size `vm.disk.change` call.
        const currentGb = Math.floor((disk.capacityInBytes ?? 0) / BYTES_PER_GB);
        if (requestedGb <= currentGb) {
          deps.log?.(
            `Disk already ${currentGb}GB (requested ${requestedGb}GB) — skipping resize`,
          );
          return;
        }

        const result = await run('govc', [
          'vm.disk.change',
          '-vm',
          p.vm,
          '-disk.key',
          String(diskKey),
          '-size',
          `${requestedGb}G`,
        ]);
        if (result.code !== 0) throwOnFailure('govc vm.disk.change', result.code, result.stderr, result.stdout);
      },
    });
  }

  if (s.network) {
    const network = s.network;
    phases.push({
      label: 'network',
      exec: async (run) => {
        const result = await run('govc', ['vm.network.change', '-vm', p.vm, '-net', network, 'ethernet-0']);
        if (result.code !== 0) throwOnFailure('govc vm.network.change', result.code, result.stderr, result.stdout);
      },
    });
  }

  phases.push({
    label: 'power-on',
    exec: async (run) => {
      const result = await run('govc', ['vm.power', '-on', p.vm]);
      if (result.code !== 0) throwOnFailure('govc vm.power', result.code, result.stderr, result.stdout);
    },
  });

  return phases;
}

/** A single-disk `govc device.info -json` response, for `makeCreateDryRun`'s canned reply. */
const FAKE_DRY_RUN_DISK_INFO = JSON.stringify({ devices: [{ key: 2000, capacityInBytes: 0 }] });

/**
 * Builds a `RunFn` for previewing `createPhases` without touching vCenter.
 * Every call is logged via `makeDryRun` like any other dry-run invocation,
 * with one addition: a `device.info` call (issued by the `grow-disk` phase
 * to re-read the not-yet-existing clone's disk) is answered with a canned
 * single-disk JSON payload instead of the real `makeDryRun` empty stdout —
 * `grow-disk`'s own exec parses that response to find the disk to resize,
 * and would otherwise throw on empty/unparseable JSON. The canned key is
 * synthetic (no real VM exists yet in dry-run mode); only the previewed
 * govc command lines carry meaning.
 */
export function makeCreateDryRun(log: (line: string) => void): RunFn {
  const dryRun = makeDryRun(log);
  return async (cmd, args) => {
    const result = await dryRun(cmd, args);
    if (args[0] === 'device.info') {
      return { ...result, stdout: FAKE_DRY_RUN_DISK_INFO };
    }
    return result;
  };
}
