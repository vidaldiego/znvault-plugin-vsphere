// Path: test/validate.test.ts
// Unit tests for the read-only preflight validations ported from
// `bootstrap-vm/new-bootstrapped-vm.sh` lines 278-368. Every test drives a
// fake `RunFn` — no real govc/vCenter is ever invoked.

import { describe, it, expect } from 'vitest';
import type { RunFn, RunResult } from '../src/run.js';
import type { VmSpec } from '../src/vm-spec.js';
import { paths } from '../src/vm-spec.js';
import { validationSteps, runValidations, resolveTemplate, resolveTargetHost } from '../src/validate.js';

const base: VmSpec = {
  name: 'trust-api-1',
  template: 'ubuntu-template-base',
  datacenter: 'ZincApp',
  cluster: 'Primary',
  datastore: 'vsanDatastore',
  network: 'VM Network',
  sshUser: 'sysadmin',
  sshKey: '/home/x/.ssh/id_ed25519',
  timeoutMinutes: 10,
};

const templatePath = '/ZincApp/vm/ubuntu-template-base';
const p = paths(base);

/** Builds a `RunFn` from an exact `"<args joined by space>"` -> RunResult map. */
function fakeRun(responses: Record<string, RunResult>): RunFn {
  return async (_cmd, args) => {
    const key = args.join(' ');
    const result = responses[key];
    if (!result) throw new Error(`fakeRun: no canned response for "govc ${key}"`);
    return result;
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const notFound = (): RunResult => ({ code: 1, stdout: '', stderr: 'not found' });
const empty = (): RunResult => ({ code: 0, stdout: '', stderr: '' });

/** Canned response for the "cluster has at least one host" step, reused by every
 * test that exercises the full no-host-pinned step list. */
const clusterHasHosts = { [`find ${p.cluster} -type h`]: ok('esx1.example.com\n') };

describe('validationSteps', () => {
  it('produces cluster/datastore/folder/network/collision/no-host checks for a spec with a network and no host', () => {
    const steps = validationSteps(base, templatePath);

    expect(steps).toEqual([
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
      {
        label: `Network exists (${p.dc}/network/VM Network)`,
        args: ['object.collect', '-s', `${p.dc}/network/VM Network`, 'name'],
        failMessage: `Network not found: ${p.dc}/network/VM Network`,
      },
      {
        label: `No naming collision (${p.vm})`,
        args: ['object.collect', '-s', p.vm, 'name'],
        invert: true,
        failMessage: `VM already exists: ${p.vm}`,
      },
      {
        label: `Cluster has at least one host (${p.cluster})`,
        args: ['find', p.cluster, '-type', 'h'],
        expect: { nonEmpty: true },
        failMessage: `No hosts found in cluster ${base.cluster}`,
      },
    ]);
  });

  it('omits the network step when no network was requested', () => {
    const steps = validationSteps({ ...base, network: undefined }, templatePath);
    expect(steps.some((s) => s.label.startsWith('Network exists'))).toBe(false);
  });

  it('adds the "cluster has at least one host" step when no host is targeted (targetHostPath undefined)', () => {
    const steps = validationSteps(base, templatePath);
    const last = steps.at(-1)!;
    expect(last.args).toEqual(['find', p.cluster, '-type', 'h']);
    expect(last.expect).toEqual({ nonEmpty: true });
    expect(last.failMessage).toBe(`No hosts found in cluster ${base.cluster}`);
  });

  it('appends host green/connected/not-in-maintenance checks (not the no-host check) when targetHostPath is given', () => {
    const hostPath = `${p.cluster}/esx1.example.com`;
    const steps = validationSteps(base, templatePath, hostPath);
    const hostFailMessage = `Host '${hostPath}' is not green, connected, and out of maintenance`;

    expect(steps.some((s) => s.label.startsWith('Cluster has at least one host'))).toBe(false);
    expect(steps.slice(-3)).toEqual([
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
    ]);
  });

  it('appends a disk precheck step (device.info -json) only when --disk-gb is given', () => {
    const withDisk = validationSteps({ ...base, diskGb: 100 }, templatePath);
    const diskStep = withDisk.at(-1)!;
    expect(diskStep.args).toEqual(['device.info', '-json', '-vm', templatePath, 'disk-*']);
    expect(diskStep.diskGb).toBe(100);

    const withoutDisk = validationSteps(base, templatePath);
    expect(withoutDisk.some((s) => s.args[0] === 'device.info')).toBe(false);
  });
});

describe('runValidations', () => {
  const steps = validationSteps(base, templatePath);

  it('all-green: every step passes -> ok:true, no failures', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.dc}/network/VM Network name`]: ok('VM Network\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('datastore inaccessible (stdout "false") -> failure with its failMessage', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('false\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.dc}/network/VM Network name`]: ok('VM Network\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`Datastore is not accessible: ${p.datastore}`]);
  });

  it('name collision (invert step, command exits 0) -> failure "VM already exists"', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.dc}/network/VM Network name`]: ok('VM Network\n'),
      [`object.collect -s ${p.vm} name`]: ok('trust-api-1\n'),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`VM already exists: ${p.vm}`]);
  });

  it('cluster not found -> failure with its failMessage', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: notFound(),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.dc}/network/VM Network name`]: ok('VM Network\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result.failures).toContain(`Cluster not found: ${p.cluster}`);
  });

  it('folder not found -> failure with its failMessage', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: notFound(),
      [`object.collect -s ${p.dc}/network/VM Network name`]: ok('VM Network\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result.failures).toContain(`VM folder not found: ${p.folder}`);
  });

  it('network not found -> failure with its failMessage', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.dc}/network/VM Network name`]: notFound(),
      [`object.collect -s ${p.vm} name`]: notFound(),
      ...clusterHasHosts,
    });

    const result = await runValidations(run, steps);
    expect(result.failures).toContain(`Network not found: ${p.dc}/network/VM Network`);
  });

  it('accumulates multiple failures rather than stopping at the first', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: notFound(),
      [`object.collect -s ${p.datastore} name`]: notFound(),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('false\n'),
      [`object.collect -s ${p.folder} name`]: notFound(),
      [`object.collect -s ${p.dc}/network/VM Network name`]: notFound(),
      [`object.collect -s ${p.vm} name`]: notFound(),
      [`find ${p.cluster} -type h`]: empty(),
    });

    const result = await runValidations(run, steps);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(1);
  });
});

describe('runValidations — cluster has at least one host', () => {
  const step = validationSteps(base, templatePath).at(-1)!;

  it('passes when `govc find <cluster> -type h` returns at least one line', async () => {
    const run = fakeRun({ [`find ${p.cluster} -type h`]: ok('esx1.example.com\nesx2.example.com\n') });
    const result = await runValidations(run, [step]);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('fails with the script\'s message when the cluster has zero hosts', async () => {
    const run = fakeRun({ [`find ${p.cluster} -type h`]: empty() });
    const result = await runValidations(run, [step]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`No hosts found in cluster ${base.cluster}`]);
  });
});

describe('runValidations — host checks', () => {
  const hostPath = `${p.cluster}/esx1`;
  const hostSteps = validationSteps({ ...base, network: undefined, host: 'esx1' }, templatePath, hostPath);

  it('host green + connected + out of maintenance -> passes', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      [`object.collect -s ${hostPath} overallStatus`]: ok('green\n'),
      [`object.collect -s ${hostPath} runtime.connectionState`]: ok('connected\n'),
      [`object.collect -s ${hostPath} runtime.inMaintenanceMode`]: ok('false\n'),
    });

    const result = await runValidations(run, hostSteps);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('host in maintenance mode -> failure naming the host', async () => {
    const run = fakeRun({
      [`object.collect -s ${p.cluster} name`]: ok('Primary\n'),
      [`object.collect -s ${p.datastore} name`]: ok('vsanDatastore\n'),
      [`object.collect -s ${p.datastore} summary.accessible`]: ok('true\n'),
      [`object.collect -s ${p.folder} name`]: ok('vm\n'),
      [`object.collect -s ${p.vm} name`]: notFound(),
      [`object.collect -s ${hostPath} overallStatus`]: ok('green\n'),
      [`object.collect -s ${hostPath} runtime.connectionState`]: ok('connected\n'),
      [`object.collect -s ${hostPath} runtime.inMaintenanceMode`]: ok('true\n'),
    });

    const result = await runValidations(run, hostSteps);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      `Host '${hostPath}' is not green, connected, and out of maintenance`,
    );
  });
});

describe('runValidations — disk precheck', () => {
  it('refuses a template with more than one disk', async () => {
    const steps = validationSteps({ ...base, diskGb: 100 }, templatePath);
    const diskStep = steps.at(-1)!;
    const run = fakeRun({
      [diskStep.args.join(' ')]: ok(
        JSON.stringify({ devices: [{ capacityInBytes: 50 * 1_073_741_824 }, { capacityInBytes: 10 * 1_073_741_824 }] }),
      ),
    });

    const result = await runValidations(run, [diskStep]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['--disk-gb requires a template with exactly one disk (found 2)']);
  });

  it('refuses to shrink the template disk', async () => {
    const steps = validationSteps({ ...base, diskGb: 20 }, templatePath);
    const diskStep = steps.at(-1)!;
    const run = fakeRun({
      [diskStep.args.join(' ')]: ok(JSON.stringify({ devices: [{ capacityInBytes: 50 * 1_073_741_824 }] })),
    });

    const result = await runValidations(run, [diskStep]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['--disk-gb cannot shrink the 50GB template disk']);
  });

  it('accepts a disk-gb at or above the template size, with exactly one disk', async () => {
    const steps = validationSteps({ ...base, diskGb: 100 }, templatePath);
    const diskStep = steps.at(-1)!;
    const run = fakeRun({
      [diskStep.args.join(' ')]: ok(JSON.stringify({ devices: [{ capacityInBytes: 50 * 1_073_741_824 }] })),
    });

    const result = await runValidations(run, [diskStep]);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('fails closed when govc device.info exits non-zero', async () => {
    const steps = validationSteps({ ...base, diskGb: 100 }, templatePath);
    const diskStep = steps.at(-1)!;
    const run = fakeRun({ [diskStep.args.join(' ')]: notFound() });

    const result = await runValidations(run, [diskStep]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([diskStep.failMessage]);
  });

  it('fails closed when govc device.info returns unparseable JSON', async () => {
    const steps = validationSteps({ ...base, diskGb: 100 }, templatePath);
    const diskStep = steps.at(-1)!;
    const run = fakeRun({ [diskStep.args.join(' ')]: ok('not json') });

    const result = await runValidations(run, [diskStep]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([diskStep.failMessage]);
  });
});

describe('resolveTemplate', () => {
  it('resolves via `govc find -type m` when it finds a match', async () => {
    const run = fakeRun({
      [`find ${p.dc} -type m -name ${base.template}`]: ok(`${templatePath}\n`),
    });

    await expect(resolveTemplate(run, base)).resolves.toBe(templatePath);
  });

  it('falls back to `-type VirtualMachine` when `-type m` finds nothing', async () => {
    const run = fakeRun({
      [`find ${p.dc} -type m -name ${base.template}`]: ok(''),
      [`find ${p.dc} -type VirtualMachine -name ${base.template}`]: ok(`${templatePath}\n`),
    });

    await expect(resolveTemplate(run, base)).resolves.toBe(templatePath);
  });

  it('takes only the first line when govc find returns multiple matches', async () => {
    const run = fakeRun({
      [`find ${p.dc} -type m -name ${base.template}`]: ok(`${templatePath}\n/ZincApp/vm/other-copy\n`),
    });

    await expect(resolveTemplate(run, base)).resolves.toBe(templatePath);
  });

  it('throws naming the template and datacenter when both lookups come up empty', async () => {
    const run = fakeRun({
      [`find ${p.dc} -type m -name ${base.template}`]: ok(''),
      [`find ${p.dc} -type VirtualMachine -name ${base.template}`]: notFound(),
    });

    await expect(resolveTemplate(run, base)).rejects.toThrow(
      new RegExp(`${base.template}.*${base.datacenter}`),
    );
  });
});

describe('resolveTargetHost', () => {
  it('returns undefined when no --host was requested', async () => {
    const run = fakeRun({});
    await expect(resolveTargetHost(run, base)).resolves.toBeUndefined();
  });

  it('resolves a bare host name via `govc find -type h -name`, anchored under the cluster', async () => {
    const hostPath = `${p.cluster}/esx1.example.com`;
    const run = fakeRun({
      [`find ${p.cluster} -type h -name esx1`]: ok(`${hostPath}\n`),
      [`object.collect -s ${hostPath} name`]: ok('esx1.example.com\n'),
    });

    await expect(resolveTargetHost(run, { ...base, host: 'esx1' })).resolves.toBe(hostPath);
  });

  it('uses an absolute --host path verbatim, without calling `govc find`', async () => {
    const hostPath = `${p.cluster}/esx1.example.com`;
    const run = fakeRun({
      [`object.collect -s ${hostPath} name`]: ok('esx1.example.com\n'),
    });

    await expect(resolveTargetHost(run, { ...base, host: hostPath })).resolves.toBe(hostPath);
  });

  it('throws "not found in cluster" when `govc find` comes up empty', async () => {
    const run = fakeRun({ [`find ${p.cluster} -type h -name ghost`]: empty() });

    await expect(resolveTargetHost(run, { ...base, host: 'ghost' })).rejects.toThrow(
      `Host 'ghost' not found in cluster ${base.cluster}`,
    );
  });

  it('throws "not found in cluster" when the resolved host is outside the cluster path', async () => {
    const outsidePath = '/ZincApp/host/OtherCluster/esx1.example.com';
    const run = fakeRun({
      [`find ${p.cluster} -type h -name esx1`]: ok(`${outsidePath}\n`),
    });

    await expect(resolveTargetHost(run, { ...base, host: 'esx1' })).rejects.toThrow(
      `Host 'esx1' not found in cluster ${base.cluster}`,
    );
  });

  it('throws "not found in cluster" when an absolute --host path is anchored but does not resolve to a real object', async () => {
    const hostPath = `${p.cluster}/ghost.example.com`;
    const run = fakeRun({
      [`object.collect -s ${hostPath} name`]: notFound(),
    });

    await expect(resolveTargetHost(run, { ...base, host: hostPath })).rejects.toThrow(
      `Host '${hostPath}' not found in cluster ${base.cluster}`,
    );
  });
});
