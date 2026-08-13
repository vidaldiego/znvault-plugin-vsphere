// Path: src/commands.ts
// Registers the `znvault vsphere <sub>` subcommands. All handlers are stubs
// for this task — Tasks 2-5 fill in `plan`/`create`/`enroll`/`status` with
// real govc-driven provisioning logic.

import type { Command } from 'commander';
import type { CLIPluginContext } from './plugin-types.js';

/** Stub handler shared by every subcommand until its task lands. */
function notImplemented(ctx: CLIPluginContext, subcommand: string): void {
  ctx.output.error(`vsphere ${subcommand}: not implemented yet`);
  process.exit(1);
}

export function registerVsphereCommands(vsphere: Command, ctx: CLIPluginContext): void {
  vsphere
    .command('plan')
    .description('Preview a VM provisioning plan (dry-run)')
    .action(() => notImplemented(ctx, 'plan'));

  vsphere
    .command('create')
    .description('Clone and bootstrap a new VM from a template')
    .action(() => notImplemented(ctx, 'create'));

  vsphere
    .command('enroll')
    .description('Enroll a provisioned VM with zn-vault-agent')
    .action(() => notImplemented(ctx, 'enroll'));

  vsphere
    .command('status')
    .description('Report provisioning/enrollment status for a VM')
    .action(() => notImplemented(ctx, 'status'));
}
