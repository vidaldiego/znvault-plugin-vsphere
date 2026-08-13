# @zincapp/znvault-plugin-vsphere

vSphere VM provisioning plugin for the `znvault` CLI. It drives `govc` to
clone VMs from a template, bootstrap them, and enroll the resulting host
with `zn-vault-agent` — the same way `znvault-plugin-webdeploy` and
`znvault-plugin-archon` extend `znvault` with deployer-specific command
groups.

It is a **CLI-only plugin** (no agent-side component — an agent plugin
can't create the VM it isn't running on yet), registered with `znvault`
through the standard plugin-loader mechanism. It wraps the same govc flow
already proven by `bootstrap-vm/new-bootstrapped-vm.sh`, so day-to-day VM
creation no longer means running that script by hand from a laptop.

## Installation

```bash
znvault plugin install vsphere
```

`znvault plugin install <name>` resolves a short name against the
`@zincapp/znvault-plugin-` prefix, so this is equivalent to
`znvault plugin install @zincapp/znvault-plugin-vsphere`. Either form works.
The plugin is downloaded into `znvault`'s local plugins directory and
becomes available as `znvault vsphere …` on the next invocation.

Requires the `govc` CLI (VMware's official govmomi CLI) on `PATH` — this
plugin shells out to it rather than talking to vCenter directly. It also
shells out to `ssh` for bootstrap/enrollment/status probes, so an SSH key
that the target template trusts (see [SSH access](#ssh-access) below) must
be available locally.

## vCenter connection (`GOVC_*`)

Every subcommand that touches vCenter requires the standard govc connection
variables to be exported first:

```bash
export GOVC_URL=https://vcenter.zincapp.internal
export GOVC_USERNAME=administrator@vsphere.local
export GOVC_PASSWORD='...'
export GOVC_INSECURE=1   # self-signed vCenter cert
```

`GOVC_URL` is checked eagerly by every command — a missing value fails fast
with a message naming all four variables, before any govc call is made. See
[Credentials](#credentials) below for the current state of how these values
are sourced (env-only today, by design).

## SSH access

`create`, `enroll`, and `status` all reach the guest over SSH. Unless
overridden with `--ssh-user`/`--ssh-key`, every command defaults to:

```
--ssh-user sysadmin
--ssh-key  ~/.ssh/id_ed25519
```

That's the operator key the fleet's `ubuntu-template-base` template already
trusts — no per-run key distribution needed. SSH-CA-backed ephemeral access
for this path is a tracked future evolution, not implemented here.

## Commands

The examples below use the parameters from the deployment this plugin was
built for — provisioning the `trust` portal's API tier (see
`docs/superpowers/specs/2026-08-13-trust-deployment-design.md` §6): a new
`trust-api-1` VM on the `Primary` cluster in the `ZincApp` datacenter,
cloned from `ubuntu-template-base`, joining the `trust-fleet` host config.

### `plan` — read-only preflight

```bash
znvault vsphere plan \
  --name trust-api-1 \
  --template ubuntu-template-base \
  --datacenter ZincApp \
  --cluster Primary \
  --datastore vsanDatastore \
  --num-cpu 2 \
  --memory-gb 4
```

Never mutates vCenter. Connects (`govc about`), resolves the template,
resolves `--host` if pinned, then runs every validation check
(cluster/datastore/folder/network exist, datastore accessible, no VM-name
collision, target host or cluster viability, disk-size sanity) and prints a
`✓`/`✗` line per check. Exits `0` only if every check passes.

### `create` — clone, configure, bootstrap, optionally enroll

`create` re-runs `plan`'s full preflight first, then clones and configures
the VM. **It previews by default** — pass `--confirm <name>` (matching
`--name` exactly) to actually touch vCenter:

```bash
# Dry run (default) — shows every govc/ssh command it WOULD run, changes nothing:
znvault vsphere create \
  --name trust-api-1 \
  --template ubuntu-template-base \
  --datacenter ZincApp \
  --cluster Primary \
  --datastore vsanDatastore \
  --num-cpu 2 \
  --memory-gb 4 \
  --static-ip 172.16.211.30/24 \
  --gateway 172.16.211.1 \
  --dns 172.16.50.250 \
  --fleet trust-fleet

# Same command, executed for real:
znvault vsphere create \
  --name trust-api-1 \
  --template ubuntu-template-base \
  --datacenter ZincApp \
  --cluster Primary \
  --datastore vsanDatastore \
  --num-cpu 2 \
  --memory-gb 4 \
  --static-ip 172.16.211.30/24 \
  --gateway 172.16.211.1 \
  --dns 172.16.50.250 \
  --fleet trust-fleet \
  --confirm trust-api-1
```

Flow once `--confirm` is given: clone (powered off) → resize CPU/RAM if
requested → grow the disk if `--disk-gb` is larger than the clone's current
disk → attach `--network` if given → power on → poll for a routable IP →
poll for SSH → run the pinned `bootstrap-vm/install.sh` over SSH with the
static-network/hostname/CA-trust flags → if `--fleet <hostConfig>` was
given **and bootstrap succeeded**, chain straight into `enroll` against that
fleet. A failed bootstrap skips enrollment (with a manual-retry hint) rather
than enrolling a host whose network/CA trust never got configured.

#### `--confirm` guard semantics

- Omit `--confirm` entirely → dry-run preview. Every mutating govc/ssh
  command is printed via `[dry-run] <cmd> <args…>` instead of executed. The
  full read-only `plan` preflight still runs for real against vCenter (so a
  dry run also validates your inputs).
- Pass `--confirm <value>` where `<value>` does not exactly equal `--name`
  → hard error, before `GOVC_URL` is even checked. A typo'd `--confirm`
  must never touch vCenter, not even a read-only call.
- Pass `--confirm <name>` matching `--name` exactly → executes for real.

### `enroll` — enroll a provisioned VM with zn-vault-agent

Normally invoked automatically by `create --fleet`, but usable standalone
against any already-provisioned, network-reachable VM (e.g. re-enrolling
after a bootstrap fix, or a VM created outside this plugin):

```bash
znvault vsphere enroll \
  --fleet trust-fleet \
  --name trust-api-1 \
  --ip 172.16.211.30
```

Requests a one-time bootstrap token for `trust-fleet` (`POST
/v1/hosts/trust-fleet/bootstrap-token`), then runs 8 sequential SSH steps:
install the pinned (or `latest`) `@zincapp/zn-vault-agent` npm package, fix
its bin symlinks, run `setup -y`, log in with the token, fix config
ownership, add a `RuntimeDirectory=` systemd drop-in, restart the service,
and verify `systemctl is-active` + a local `/health` curl. Stops at the
first failing step and reports its label — never a raw, unlabeled ssh
transcript.

If bootstrap itself needs to be redone first (e.g. the VM's static network
or CA trust was never configured), add `--retry-bootstrap` plus the same
network/CA flags `create` takes:

```bash
znvault vsphere enroll \
  --fleet trust-fleet \
  --name trust-api-1 \
  --ip 172.16.211.30 \
  --retry-bootstrap \
  --static-ip 172.16.211.30/24 \
  --gateway 172.16.211.1 \
  --dns 172.16.50.250
```

#### Enrollment gotchas (encoded, not just documented)

`enroll` bakes in fixes for four real gotchas hit while enrolling Archon
nodes by hand (see
[`archon-node/docs/runbooks/ZN_VAULT_AGENT_ENROLLMENT.md`](https://github.com/vidaldiego/archon-node/blob/main/docs/runbooks/ZN_VAULT_AGENT_ENROLLMENT.md)),
so an operator never has to remember them:

1. **Bin symlink.** npm's auto-created `/usr/bin/zn-vault-agent` symlink can
   point at a non-existent `bin/zn-vault-agent`. Both `/usr/bin` and
   `/usr/local/bin` are re-pointed at the real entrypoint (the systemd
   unit's `ExecStart` uses `/usr/local/bin`) before `setup` runs.
2. **Config ownership.** `login` runs under `sudo` (root), leaving
   `/etc/zn-vault-agent/config.json` root-owned. The service runs as user
   `zn-vault-agent` and would `EACCES` crash-loop without the `chown` step
   that follows login.
3. **Missing `RuntimeDirectory=`.** The installed unit doesn't declare it,
   so `/run/zn-vault-agent` is never auto-created. A systemd drop-in adds
   it, followed by `daemon-reload`.
4. **Restart to pick up both fixes**, then verify with
   `systemctl is-active` + a local health-endpoint curl.

#### Token hygiene

The bootstrap token is embedded in exactly one SSH command string (the
`login` step) — that string goes straight to `ssh`, never to `ctx.output`.
Every log line that references the token instead prints a redacted form
(`zrt_<first 8 chars>…`), so the full token never appears in CLI output,
piped logs, or CI transcripts.

### `status` — report provisioning/enrollment state

```bash
znvault vsphere status --name trust-api-1
```

```
Status for trust-api-1:
  Power: poweredOn
  IP:    172.16.211.30
  SSH:   reachable
  Agent: healthy
```

Checks, in order, each gated on the previous one: `govc vm.info -json` for
power state (exits `1` if the VM doesn't exist at all — this is the only
case that fails the command); a best-effort `govc vm.ip -a -v4 -wait=5s`
(a missing IP is not an error — the VM may simply not have leased one yet);
an `echo ok` SSH probe; and, only if SSH succeeded, `curl -sf
http://localhost:9100/health` over that same SSH connection for the agent's
health endpoint. **`status` reports, it doesn't gate**: a degraded result
(no IP yet, SSH unreachable, agent unhealthy) is a normal, successful
`status` run and still exits `0` — only "can't find/query the VM at all"
exits non-zero. Accepts `--ssh-user`/`--ssh-key` overrides for the
reachability/agent probes, same defaults as `create`/`enroll`.

## Credentials

**Today: `GOVC_*` environment variables only (accepted, documented
trade-off — see decision D4 in the deployment design doc referenced
above).** The vCenter credential currently lives in plaintext in an
operator's shell environment / `.env` file rather than in vault itself —
the same status quo as the `infra-vsphere/.env` credential this plugin's
`govc` calls already depended on. This is a deliberate, temporarily
accepted risk (tracked in the ZincApp risk register once loaded), not an
oversight.

**Future evolution:** resolving the vCenter credential from a vault alias
(e.g. `infra/vsphere/vcenter`) first, falling back to `GOVC_*` env vars,
is a planned enhancement — and by design a **configuration-only** change
when it lands: `run.ts`'s `requireGovcEnv`/`execRun` already funnel every
govc invocation through `process.env`, so swapping the credential source
means populating those same env vars from a resolved vault secret before
the first govc call, not touching any command's logic.

## Development

```bash
npm install
npm run build           # tsc
npm test                # vitest run
npm run typecheck       # tsc --noEmit
npm run lint             # eslint
npm run build:prod      # clean production build (what `prepublishOnly` runs)
```

Every command handler (`runPlan`/`runCreate`/`runEnroll`/`runStatus`) is a
plain async function that takes an injectable `RunFn` and returns a process
exit code — the `.action()` registered with commander is a one-line shim
that calls it and only then touches `process.exit`. That's what lets the
whole test suite run without ever invoking real `govc`/`ssh`.

## Release process

Publishing is **tag-triggered, OIDC-based** (no long-lived npm token in
CI): pushing a `v*` tag runs `.github/workflows/publish.yml`, which builds,
tests, then `npm publish --provenance` using npm's Trusted Publishing (npm
picks up the GitHub Actions OIDC token automatically — no `NODE_AUTH_TOKEN`
involved).

**Prerequisite (one-time, manual, done on npmjs.com):** the package's
Trusted Publisher must be registered against this repo + workflow before
the first tagged release can publish — npm rejects the OIDC token
otherwise. This is an owner-level action outside this plugin's own tooling
(the same registration every sibling `znvault-plugin-*` package needed
once). Until it's registered, `v*` tags should not be pushed — the publish
job would fail at the `npm publish` step.

```bash
# Bump the version (edits package.json, no git action):
npm version patch --no-git-tag-version   # or minor/major
git add package.json package-lock.json
git commit -m "chore(release): v0.1.0"

# Tag and push — this is what actually triggers publish.yml:
git tag v0.1.0
git push origin main
git push origin v0.1.0
# → publish.yml builds, tests, and publishes @zincapp/znvault-plugin-vsphere@0.1.0
```

## License

MIT
