import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import createVspherePlugin, { PLUGIN_VERSION } from '../src/cli.js';

function fakeCtx() {
  return {
    client: { get: async () => ({}) as never, post: async () => ({}) as never },
    output: { success() {}, error() {}, warn() {}, info() {} },
    getConfig: () => ({ url: 'https://vault.test' }),
    isPlainMode: () => true,
  };
}

describe('vsphere CLI plugin', () => {
  it('exposes name, a real semver version and registerCommands', () => {
    const plugin = createVspherePlugin();
    expect(plugin.name).toBe('vsphere');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PLUGIN_VERSION).not.toBe('0.0.0'); // packaging regression guard (archon lesson)
  });

  it('registers provisioning and fixed LAB fence subcommands', () => {
    const plugin = createVspherePlugin();
    const program = new Command();
    plugin.registerCommands(program, fakeCtx() as never);
    const vsphere = program.commands.find((c) => c.name() === 'vsphere');
    expect(vsphere).toBeTruthy();
    const subs = vsphere!.commands.map((c) => c.name());
    for (const s of ['plan', 'create', 'enroll', 'status', 'fence-status', 'fence-source']) {
      expect(subs).toContain(s);
    }
  });
});
