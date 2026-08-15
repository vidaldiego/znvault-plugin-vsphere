import { describe, it, expect } from 'vitest';
import { paths, cloneArgs, bootstrapCommand } from '../src/vm-spec.js';

const base = {
  name: 'trust-api-1', template: 'ubuntu-template-base', datacenter: 'ZincApp',
  cluster: 'Primary', datastore: 'vsanDatastore', sshUser: 'sysadmin',
  sshKey: '/home/x/.ssh/id_ed25519', timeoutMinutes: 10,
};

describe('paths', () => {
  it('builds inventory paths like the proven script', () => {
    const p = paths({ ...base, folder: 'Trust' });
    expect(p.dc).toBe('/ZincApp');
    expect(p.cluster).toBe('/ZincApp/host/Primary');
    expect(p.datastore).toBe('/ZincApp/datastore/vsanDatastore');
    expect(p.folder).toBe('/ZincApp/vm/Trust');
    expect(p.vm).toBe('/ZincApp/vm/Trust/trust-api-1');
  });
  it('defaults folder to the datacenter vm root', () => {
    expect(paths(base).folder).toBe('/ZincApp/vm');
  });
});

describe('cloneArgs', () => {
  it('clones powered-off onto the cluster when no host is pinned', () => {
    expect(cloneArgs(base, '/ZincApp/vm/tpl')).toEqual([
      'vm.clone', '-vm', '/ZincApp/vm/tpl', '-ds', '/ZincApp/datastore/vsanDatastore',
      '-folder', '/ZincApp/vm', '-on=false', '-cluster', '/ZincApp/host/Primary', 'trust-api-1',
    ]);
  });
  it('pins to a host path when given', () => {
    expect(cloneArgs(base, '/ZincApp/vm/tpl', '/ZincApp/host/Primary/esx1')).toContain('-host');
  });
});

describe('bootstrapCommand', () => {
  it('always appends --yes and forwards static network flags', () => {
    const cmd = bootstrapCommand({ ...base, staticIp: '192.0.2.30/24', gateway: '192.0.2.1', dns: '203.0.113.53' });
    expect(cmd).toContain('install.sh | bash -s -- --hostname trust-api-1');
    expect(cmd).toContain('--static-ip 192.0.2.30/24');
    expect(cmd).toContain('--gateway 192.0.2.1');
    expect(cmd).toContain('--dns "203.0.113.53"');
    expect(cmd.trim().endsWith('--yes')).toBe(true);
  });
  it('omits absent flags', () => {
    expect(bootstrapCommand(base)).not.toContain('--static-ip');
  });
});
