// Path: src/vm-spec.ts
// Pure VM-spec builders consumed by Tasks 3-5 (plan/create/enroll/status).
// These are a direct port of the proven production script
// `bootstrap-vm/new-bootstrapped-vm.sh` — inventory path construction
// (lines 216-227), the `govc vm.clone` argv (lines 395-415), and the
// bootstrap command line (lines 502-529). No govc/ssh calls happen here;
// everything is string-building so it can be unit-tested without a
// vCenter or a VM.

/** Declarative description of a VM to provision. Pure data, no I/O. */
export interface VmSpec {
  name: string;
  template: string;
  datacenter: string;
  cluster: string;
  datastore: string;
  folder?: string;
  network?: string;
  host?: string;
  resourcePool?: string;
  numCpu?: number;
  memoryGb?: number;
  diskGb?: number;
  staticIp?: string;
  gateway?: string;
  dns?: string;
  sshUser: string; // default 'sysadmin'
  sshKey: string; // default ~/.ssh/id_ed25519
  noSshCa?: boolean;
  noPkiCa?: boolean;
  bootstrapArgs?: string;
  timeoutMinutes: number; // default 10
}

/** vSphere inventory paths derived from a spec, as govc expects them. */
export interface VmPaths {
  dc: string;
  cluster: string;
  datastore: string;
  folder: string;
  vm: string;
}

/**
 * Builds the vCenter inventory paths for a spec — mirrors
 * `new-bootstrapped-vm.sh` lines 216-227: `DC_PATH="/$DATACENTER"`,
 * `CLUSTER_PATH="$DC_PATH/host/$CLUSTER"`,
 * `DATASTORE_PATH="$DC_PATH/datastore/$DATASTORE"`, and `VM_FOLDER`
 * defaulting to the datacenter's `vm` root when no folder is given.
 */
export function paths(s: VmSpec): VmPaths {
  const dc = `/${s.datacenter}`;
  const cluster = `${dc}/host/${s.cluster}`;
  const datastore = `${dc}/datastore/${s.datastore}`;
  const folder = s.folder ? `${dc}/vm/${s.folder}` : `${dc}/vm`;
  const vm = `${folder}/${s.name}`;
  return { dc, cluster, datastore, folder, vm };
}

/**
 * Builds the `govc vm.clone` argv — mirrors lines 395-415. Clones
 * powered-off (`-on=false`) into the resolved datastore/folder, pinned to
 * `targetHostPath` (`-host`) when given, otherwise left to DRS placement on
 * the cluster (`-cluster`). Appends `-pool` when a resource pool is set,
 * using the same `<cluster>/Resources/<pool>` path the script builds.
 */
export function cloneArgs(s: VmSpec, templatePath: string, targetHostPath?: string): string[] {
  const p = paths(s);
  const args = ['vm.clone', '-vm', templatePath, '-ds', p.datastore, '-folder', p.folder, '-on=false'];

  if (targetHostPath) {
    args.push('-host', targetHostPath);
  } else {
    args.push('-cluster', p.cluster);
  }

  if (s.resourcePool) {
    args.push('-pool', `${p.cluster}/Resources/${s.resourcePool}`);
  }

  args.push(s.name);
  return args;
}

/**
 * Builds the bootstrap command line run over SSH — mirrors lines 502-529.
 * Always installs via the pinned `install.sh` URL and forwards
 * `--hostname`, then appends the optional static-network flags, the
 * `--no-ssh-ca`/`--no-pki-ca` overrides, any raw `bootstrapArgs` passthrough,
 * and finally `--yes` — unconditionally, every time, so the remote install
 * never blocks on an interactive confirmation prompt.
 */
export function bootstrapCommand(s: VmSpec): string {
  const parts = [
    'curl -fsSL https://raw.githubusercontent.com/vidaldiego/bootstrap-vm/main/install.sh | bash -s --',
    `--hostname ${s.name}`,
  ];

  if (s.staticIp) parts.push(`--static-ip ${s.staticIp}`);
  if (s.gateway) parts.push(`--gateway ${s.gateway}`);
  if (s.dns) parts.push(`--dns "${s.dns}"`);
  if (s.noSshCa) parts.push('--no-ssh-ca');
  if (s.noPkiCa) parts.push('--no-pki-ca');
  if (s.bootstrapArgs) parts.push(s.bootstrapArgs);
  parts.push('--yes');

  return parts.join(' ');
}
