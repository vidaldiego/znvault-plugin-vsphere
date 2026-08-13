// Path: src/cli.ts
// znvault CLI plugin entrypoint. The loader imports the DEFAULT export and
// calls it as a factory, so this file must `export default` the factory.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { CLIPlugin, CLIPluginContext } from './plugin-types.js';
import { registerVsphereCommands } from './commands.js';

// The znvault-cli plugin loader rejects any plugin without a non-empty
// `version` string. Read it from our own package.json at module load, with
// a fallback so a packaging quirk degrades to a valid-but-unknown version
// rather than a hard load failure (archon lesson — see PLUGIN_VERSION in
// znvault-plugin-archon/src/index.ts).
export const PLUGIN_VERSION: string = (() => {
  try {
    // dist/cli.js → package.json is one level up (../package.json).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export default function createVspherePlugin(): CLIPlugin {
  return {
    name: 'vsphere',
    version: PLUGIN_VERSION,
    description: 'vSphere VM provisioning (govc clone + bootstrap + zn-vault-agent enrollment)',
    registerCommands(program: Command, ctx: CLIPluginContext): void {
      const vsphere = program.command('vsphere').description('vSphere VM provisioning');
      registerVsphereCommands(vsphere, ctx);
    },
  };
}
