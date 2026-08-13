// Path: src/validate.ts
// Read-only preflight validations consumed by `vsphere plan` (Task 3). Ports
// the read-only block of `bootstrap-vm/new-bootstrapped-vm.sh` lines 301-368
// (target-resource resolution + validation) and the template resolution at
// lines 286-298. None of this ever mutates vCenter state — every govc
// invocation here is `object.collect`/`find`/`device.info`, never
// `vm.clone`/`vm.power`/etc.

import type { RunFn, RunResult } from './run.js';
import type { VmSpec } from './vm-spec.js';
import { paths } from './vm-spec.js';

/**
 * A single read-only govc check. `runValidations` runs `args` via `govc` and
 * decides pass/fail as follows:
 *  - `expect.equals` set: compare `result.stdout.trim()` against it (mirrors
 *    the script's `[[ "$(govc object.collect ...)" != "value" ]]` checks —
 *    e.g. `summary.accessible` must equal `"true"`).
 *  - `expect` absent: pass when the command exits 0 (mirrors the script's
 *    `govc object.collect -s "$PATH" name >/dev/null 2>&1` existence checks).
 *  - `invert: true` flips the verdict — used for the name-collision check,
 *    which must FAIL when `govc object.collect` on the target VM path
 *    *succeeds* (i.e. a VM already exists there).
 *
 * `diskGb`, when set, marks this as the disk-precheck step (script lines
 * 353-368: template must have exactly one disk, and `diskGb` must not shrink
 * it). It carries the requested `--disk-gb` value so `runValidations` can
 * parse the `govc device.info -json` output and compare it — a check that
 * cannot be expressed as a static string-equals, unlike every other step
 * here. This is the "dedicated step type" the task brief invited: same
 * `ValidationStep` shape, one extra optional field, evaluated by dedicated
 * logic in `runValidations` instead of the generic equals/invert path.
 */
export interface ValidationStep {
  label: string;
  args: string[];
  expect?: { equals?: string };
  failMessage: string;
  invert?: boolean;
  diskGb?: number;
}

const BYTES_PER_GB = 1_073_741_824;

/**
 * Builds the read-only validation steps for a spec — ports script lines
 * 301-368 (minus the DRS-placement "no hosts found in cluster" branch at
 * 348-351, which is a *DRS-viability* check with no vSphere-permission or
 * user-facing knob attached to it here; out of scope for this task's
 * read-only preflight per the brief's own checklist):
 *  1. Cluster exists.
 *  2. Datastore exists.
 *  3. Datastore is accessible (`summary.accessible == "true"`).
 *  4. VM folder exists.
 *  5. Network exists — only when `s.network` is set.
 *  6. No naming collision — `paths(s).vm` must NOT already exist (`invert`).
 *  7. If `s.host` is pinned: host `overallStatus == "green"`,
 *     `runtime.connectionState == "connected"`,
 *     `runtime.inMaintenanceMode == "false"` (three checks, one govc call
 *     each, sharing the script's combined failure wording). A `s.host`
 *     starting with `/` is used verbatim (already a govc inventory path,
 *     mirroring the script's `$TARGET_HOST == /*` branch); otherwise it is
 *     resolved as a direct child of the cluster path, the common case for an
 *     ESXi host object.
 *  8. If `s.diskGb` is set: the disk-precheck step (see `ValidationStep`'s
 *     doc comment) — this is the only step that needs `templatePath`.
 */
export function validationSteps(s: VmSpec, templatePath: string): ValidationStep[] {
  const p = paths(s);
  const steps: ValidationStep[] = [
    {
      label: `Cluster exists (${p.cluster})`,
      args: ['object.collect', '-s', p.cluster, 'name'],
      failMessage: `Cluster not found: ${p.cluster}`,
    },
    {
      label: `Datastore exists (${p.datastore})`,
      args: ['object.collect', '-s', p.datastore, 'name'],
      failMessage: `Datastore not found: ${p.datastore}`,
    },
    {
      label: `Datastore accessible (${p.datastore})`,
      args: ['object.collect', '-s', p.datastore, 'summary.accessible'],
      expect: { equals: 'true' },
      failMessage: `Datastore is not accessible: ${p.datastore}`,
    },
    {
      label: `VM folder exists (${p.folder})`,
      args: ['object.collect', '-s', p.folder, 'name'],
      failMessage: `VM folder not found: ${p.folder}`,
    },
  ];

  if (s.network) {
    const networkPath = `${p.dc}/network/${s.network}`;
    steps.push({
      label: `Network exists (${networkPath})`,
      args: ['object.collect', '-s', networkPath, 'name'],
      failMessage: `Network not found: ${networkPath}`,
    });
  }

  steps.push({
    label: `No naming collision (${p.vm})`,
    args: ['object.collect', '-s', p.vm, 'name'],
    invert: true,
    failMessage: `VM already exists: ${p.vm}`,
  });

  if (s.host) {
    const hostPath = s.host.startsWith('/') ? s.host : `${p.cluster}/${s.host}`;
    const hostFailMessage = `Host '${hostPath}' is not green, connected, and out of maintenance`;
    steps.push(
      {
        label: `Host status green (${hostPath})`,
        args: ['object.collect', '-s', hostPath, 'overallStatus'],
        expect: { equals: 'green' },
        failMessage: hostFailMessage,
      },
      {
        label: `Host connected (${hostPath})`,
        args: ['object.collect', '-s', hostPath, 'runtime.connectionState'],
        expect: { equals: 'connected' },
        failMessage: hostFailMessage,
      },
      {
        label: `Host out of maintenance (${hostPath})`,
        args: ['object.collect', '-s', hostPath, 'runtime.inMaintenanceMode'],
        expect: { equals: 'false' },
        failMessage: hostFailMessage,
      },
    );
  }

  if (s.diskGb !== undefined) {
    steps.push({
      label: `Disk size (--disk-gb ${s.diskGb}) compatible with template`,
      args: ['device.info', '-json', '-vm', templatePath, 'disk-*'],
      failMessage: `Failed to inspect template disk(s): ${templatePath}`,
      diskGb: s.diskGb,
    });
  }

  return steps;
}

/** Parsed shape of `govc device.info -json ... 'disk-*'` (fields we use only). */
interface TemplateDiskInfo {
  devices?: Array<{ capacityInBytes?: number }>;
}

/**
 * Evaluates the disk-precheck step: exactly one disk on the template, and
 * `step.diskGb` must not shrink it. Returns `null` on success or the failure
 * message to surface. A non-zero exit or unparseable JSON fails closed with
 * `step.failMessage` (mirrors every other step here refusing to proceed on
 * an unexpected govc error rather than silently passing).
 */
function evaluateDiskPrecheck(step: ValidationStep, result: RunResult): string | null {
  if (result.code !== 0) return step.failMessage;

  let parsed: TemplateDiskInfo;
  try {
    parsed = JSON.parse(result.stdout) as TemplateDiskInfo;
  } catch {
    return step.failMessage;
  }

  const devices = parsed.devices ?? [];
  if (devices.length !== 1) {
    return `--disk-gb requires a template with exactly one disk (found ${devices.length})`;
  }

  const capacityBytes = devices[0]?.capacityInBytes ?? 0;
  const templateDiskGb = Math.floor(capacityBytes / BYTES_PER_GB);
  const requestedDiskGb = step.diskGb ?? 0;
  if (requestedDiskGb < templateDiskGb) {
    return `--disk-gb cannot shrink the ${templateDiskGb}GB template disk`;
  }

  return null;
}

/** Evaluates every non-disk-precheck step's generic equals/exit-code/invert rule. */
function evaluateStandardStep(step: ValidationStep, result: RunResult): boolean {
  const passed =
    step.expect?.equals !== undefined ? result.stdout.trim() === step.expect.equals : result.code === 0;
  return step.invert ? !passed : passed;
}

/**
 * Runs every step (never short-circuits on the first failure — `plan` shows
 * a full pass/fail summary, like `terraform plan`, not a fail-fast script)
 * and collects each failing step's `failMessage` (or, for the disk-precheck
 * step, its dynamically computed message).
 */
export async function runValidations(
  run: RunFn,
  steps: ValidationStep[],
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];

  for (const step of steps) {
    const result = await run('govc', step.args);

    if (step.diskGb !== undefined) {
      const diskFailure = evaluateDiskPrecheck(step, result);
      if (diskFailure) failures.push(diskFailure);
      continue;
    }

    if (!evaluateStandardStep(step, result)) failures.push(step.failMessage);
  }

  return { ok: failures.length === 0, failures };
}

function firstLine(stdout: string): string {
  return stdout.split('\n')[0]?.trim() ?? '';
}

/**
 * Resolves the template's inventory path — ports script lines 286-298:
 * `govc find <dc> -type m -name <template>`, taking the first line; if that
 * comes up empty, falls back to `-type VirtualMachine` (some templates are
 * left as regular, powered-off VMs rather than marked as templates). Throws
 * naming the template and datacenter when both come up empty.
 */
export async function resolveTemplate(run: RunFn, s: VmSpec): Promise<string> {
  const dc = paths(s).dc;

  const byTemplate = await run('govc', ['find', dc, '-type', 'm', '-name', s.template]);
  const templateMatch = firstLine(byTemplate.stdout);
  if (templateMatch) return templateMatch;

  const byVirtualMachine = await run('govc', ['find', dc, '-type', 'VirtualMachine', '-name', s.template]);
  const vmMatch = firstLine(byVirtualMachine.stdout);
  if (vmMatch) return vmMatch;

  throw new Error(`Template '${s.template}' not found in ${s.datacenter}`);
}
