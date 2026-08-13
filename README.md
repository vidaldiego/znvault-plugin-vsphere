# @zincapp/znvault-plugin-vsphere

vSphere VM provisioning plugin for the `znvault` CLI. It drives `govc` to
clone VMs from a template, bootstrap them, and enroll the resulting host
with `zn-vault-agent` — the same way `znvault-plugin-webdeploy` and
`znvault-plugin-archon` extend `znvault` with deployer-specific command
groups.

It is a **CLI-only plugin** (no agent-side component), registered with
`znvault` through the standard plugin-loader mechanism (`znvault plugin
install @zincapp/znvault-plugin-vsphere`).

## Commands

```
znvault vsphere plan      # Preview a VM provisioning plan (dry-run)
znvault vsphere create    # Clone + bootstrap a new VM from a template
znvault vsphere enroll    # Enroll a provisioned VM with zn-vault-agent
znvault vsphere status    # Report provisioning/enrollment status
```

`plan`, `create`, and `enroll` are implemented; `status` remains a stub —
see the project's `.superpowers/sdd/` task list for the task that fills it
in.

## Development

```bash
npm install
npm run build          # tsc
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run lint            # eslint
```

## License

MIT
