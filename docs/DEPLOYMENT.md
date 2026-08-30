# Deployment contract

Status: native disabled-by-default installer and authority broker source, writer disabled

FreedTown is the Freed-specific deployment of the reusable AubTown platform. Operator-facing service descriptions and GitHub App identities use FreedTown. Stable package names, protocol names, service accounts, and filesystem paths remain AubTown so another repository deployment does not require a fork of the platform.

## Pilot topology

- One always-on Ubuntu 24.04 or Debian 13 Linux host
- One pinned Symphony executable under `/opt/aubtown/symphony/<commit>`
- One immutable AubTown build under `/opt/aubtown/releases/<revision>`
- One Linux SSH worker alias and one optional Mac SSH worker alias
- systemd on Linux
- Tailscale for private dashboard and operator access
- persistent storage for `/var/lib/aubtown`
- one isolated `CODEX_HOME` per execution account

Docker Desktop, Docker Engine, Compose, Restate, PostgreSQL, Redis, and a second queue are not runtime dependencies.

## Immutable release bundle

Build each host release on the target operating system and architecture with the pinned Node toolchain:

```sh
npm ci
npm run check
npm run release:bundle
```

The build deletes `dist` before compilation so removed modules cannot survive as stale runtime files. `release:bundle` refuses a dirty Git tree, copies only the compiled output and tracked operational assets, installs production dependencies with `npm ci --omit=dev --ignore-scripts`, removes dependency command shims, normalizes file modes, and writes `.aubtown/releases/<commit>/release-manifest.json`. The manifest binds the commit, operating system, architecture, Node version, exact file set, modes, sizes, and SHA-256 digests. Linux and macOS therefore receive separate bundles from the same reviewed commit.

Copy the completed directory to `/opt/aubtown/releases/<commit>`, make the entire tree root-owned, and run:

```sh
/opt/aubtown/node/bin/node /opt/aubtown/releases/<commit>/dist/cli/verify-release-install.js /opt/aubtown/releases/<commit>
```

The installed verifier rejects the wrong path, platform, architecture, Node version, owner, mode, digest, missing file, unexpected file, or any symbolic link. Point `/opt/aubtown/current` at the release only after this proof succeeds. The pilot audit reruns the complete manifest verification at launch and still binds its critical executables individually. The release manifest closes the broader dependency and stale-file gap around them.

## Disabled Linux host installation

The release includes one native installer CLI. Plan the exact host change first:

```sh
/opt/aubtown/node/bin/node /opt/aubtown/releases/<commit>/dist/cli/install-linux-host.js \
  --plan \
  --release-root /opt/aubtown/releases/<commit>
```

Apply only after reviewing that plan:

```sh
sudo /opt/aubtown/node/bin/node /opt/aubtown/releases/<commit>/dist/cli/install-linux-host.js \
  --apply \
  --release-root /opt/aubtown/releases/<commit>
```

The installer verifies the root-owned release manifest before touching host state. It creates or verifies the four fixed service identities, exact private state directories, root configuration directories, and the reviewed systemd units. The Symphony and checkpoint identities use `nologin`. The executor and publisher identities use `/bin/bash` because OpenSSH invokes their reviewed remote or forced commands through the account shell. Password authentication, forwarding, interactive terminals, and unrestricted publisher commands remain prohibited by the SSH policy. The installer then points `/opt/aubtown/current` at that release and reloads systemd. It never enables or starts a unit. After installation it requires every unit to report `inactive` and either `disabled` or `static`.

An exact retry is idempotent. A changed unit or a different active release fails closed unless the owner explicitly passes `--replace` while all units remain inactive. The installer creates no environment file, token, private key, Codex login, repository checkout, scheduler process, network listener, or provider traffic.

## Service graph

`aubtown-symphony.service` runs the one FreedTown scheduler and dashboard as `aubtown-symphony`. It binds the dashboard to `127.0.0.1:7080`. Tailscale may expose that loopback service privately. Never bind it to a public interface. The service sandbox keeps Freed authority state read-only except for the existing task and event kernel lock files that supported advisory reads must open. Those lock exceptions grant no direct task, claim, lease, event, or outcome mutation. Symphony does not own or receive local write access to the executor workspace root. Workspace creation and mutation occur through the pinned SSH executor identity, preserving host custody and the installer-owned executor permissions.

The unit pins its `PATH` to the reviewed Erlang/OTP 28 runtime used to build the Symphony escript, followed by AubTown's pinned Node runtime and fixed system paths. The service never depends on an interactive shell profile or a distribution Erlang package whose major version may differ from the pinned build.

The pinned Symphony runner invokes `dist/cli/symphony-active-run-guard.js` every 30 seconds while a Codex turn is active. The guard reads the same protected admission envelope, host enrollment, heartbeat, and rolling-week account journal used by prelaunch. An exact hard-limit response sends `turn/interrupt` for that thread and turn. If cancellation does not finish within five seconds, Symphony closes the app-server transport.

`aubtown-github-token.timer` refreshes the FreedTown Coordinator GitHub App installation token every 35 minutes. The one-shot refresher runs before Symphony starts, reads the host-side private key, and atomically replaces a mode-0600 token file. The initial native deployment uses the same restricted OS identity for the refresher and coordinator because Symphony must read that file. The private key remains outside Symphony's workflow and worker environments.

`aubtown-host-gateway.service` receives signed heartbeat and quota envelopes as `aubtown-symphony`. It binds to `127.0.0.1:8090`, persists `/var/lib/aubtown/coordinator/host-observations.json`, and reads only enrolled public keys from `/etc/aubtown/hosts.json`. A Mac reaches it through a private Tailscale HTTPS forward. Do not bind it publicly. Execution, workspace, restore, checkpoint, validation, and review commands remain closed until their coordinator state machines and the Freed claim path are enabled.

`aubtown-host-agent.service` currently runs `dist/host-monitor.js`. Despite the legacy unit filename, this process only reads Codex rate limits and cumulative token activity, then sends signed heartbeat and quota observations. If either required meter is missing or invalid, it fails closed instead of dispatching from partial telemetry. It does not run AubTown's optional executor, workspace, validation, checkpoint, or adjudication supervisors. Symphony owns execution.

On Linux, the monitor runs as `aubtown-symphony` and reads the same single private `CODEX_HOME` used by the coordinator. Do not copy `auth.json` into the executor account or grant the executor access to the coordinator home. The enrolled Linux host signing key used by this monitor is a separate host identity credential at `/etc/aubtown/keys/linux-host-private.pem`. It must be owned by `aubtown-symphony`, mode 0600. The matching public key remains in `/etc/aubtown/hosts.json`. The monitor's durable envelope sequence lives in `/var/lib/aubtown/symphony/host-envelope.sequence`. The worker receives neither Codex authentication state nor the host signing key.

`aubtown-planning-snapshot.timer` invokes a native one-shot collector once per minute. The collector reads GitHub, the supported Freed task command, signed host state, local Git refs, and local worktrees. Its sandbox grants write access only to the coordinator report directory and Freed's existing `tasks` and `events` kernel-lock files, which the supported task reader must open for one coherent advisory read transaction. It cannot write the task manifest, event ledger, leases, outcomes, or their directories. The collector atomically replaces `/var/lib/aubtown/coordinator/planning-snapshot.json` and `/var/lib/aubtown/coordinator/dispatch-intention.json`. The second file contains either one deterministic proposed initial dispatch or explicit blockers. These files are read-only planning evidence. Neither is an execution claim, candidate, queue, or launch authority. When pilot readiness starts the full dependency graph, this collector waits for disposable broker conformance to finish so its 90-second evidence window begins after the long authority proof, not before it.

`aubtown-pilot-readiness.service` is a manual, read-only launch gate. Its first preflight probes the selected executor through the configured Symphony SSH alias and writes `/var/lib/aubtown/coordinator/executor-readiness.json`. That probe verifies the protected worker config, physical Freed checkout, writable workspace root, private handoff root, exact `origin/dev` head, pinned Node and Git runtimes, physical worktree helper, immutable workspace preparer, trusted completion entrypoint and reader, and trusted adjudicator. Its second preflight uses the separate `<host>-publisher` alias and writes `/var/lib/aubtown/coordinator/publisher-readiness.json`. It proves that the publisher SSH key reached the installed forced-command gateway, then verifies the `aubtown-publisher` account, pinned Node and Git, root-owned runtime and code, mode-0600 owner-held App key, repository allowlist, readable worktree root, gateway digest, and draft publisher digest. A final preflight refreshes the planning snapshot after both probes so their timestamps and selected-host evidence form one coherent set. The audit binds both fresh reports to the same selected host, repository, workspace root, and installed release. It also verifies protected coordinator runtime files, the immutable Symphony executable path, every reviewed patch digest, the workflow policy, prelaunch and active-guard builds, the installed Freed claim broker, a planning snapshot no older than 90 seconds, one coherent ready dispatch, and an explicitly enabled lifecycle projection gate. It writes `/var/lib/aubtown/coordinator/pilot-readiness.json` and exits nonzero when any check fails. A blocked report is evidence, not permission to weaken the check.

Workspace preparation invokes Freed's physical `scripts/worktree-add.sh` with `NODE_BIN` set to the protected worker runtime's pinned Node executable and a minimal fixed `PATH` containing only the pinned Node and Git directories plus system utilities. The command does not depend on an interactive shell profile or inherit arbitrary worker environment variables.

`aubtown-claim-reconciliation.timer` runs the native claim reconciler every minute. The same command runs as Symphony's `ExecStartPre` with `--require-clear`. An active guard heartbeat no older than 120 seconds or a claim inside its initial five-minute grace keeps custody intact. Older unlaunched `claimed` records are released through the broker with the exact last heartbeat, task revision, claim, binding, and custody epoch. If a heartbeat races that release, the broker rejects it and Symphony remains stopped. Stale `running` records are never released by age. They remain fenced for workspace restart or checkpoint transfer. This service needs only the broker endpoint and its own report file. It does not read or edit Freed authority files.

`aubtown-freed-broker-conformance.service` runs immediately before pilot readiness against a disposable `conformance-*` broker profile. Linux keeps the disposable actor launchers in the protected `/etc/freed/automation-actor-launchers-conformance` tree. A private read-only systemd bind mount presents that tree at Freed's standard launcher path only inside the conformance service. Production processes continue seeing `/etc/freed/automation-actor-launchers`, so the proof never swaps or weakens live authority. Each operation starts a separate broker process. The gate checks acquire, exact replay, changed-replay rejection, claim projection, duplicate rejection, heartbeat, checkpoint-backed transfer, stale-epoch fencing, permanent historical-operation fencing, exact release, and post-release restart state. Its protected report binds the exact broker path and SHA-256 digest. The report's `checkedAt` records when the attempt finishes, so a long proof does not expire while it is still running. Pilot readiness accepts only a complete passing report completed within the last 10 minutes for the executable it is about to trust.

`aubtown-completion-reconciliation.timer` checks the owner-selected pilot issue once per minute. It reads the exact trusted completion from the selected executor, then rereads GitHub eligibility, current Freed task authority, current broker claim, implementation-turn custody, and subscription usage. A matching completion produces one immutable adjudication command. The same executor validates the clean committed patch using the protected repository validation profile and starts a separate read-only reviewer app-server under `/etc/aubtown/reviewer-runtime.json`. The model is checked for callability at use time. Usage is reread before review and sampled while the reviewer runs. Hard daily or rolling-week decisions interrupt the exact review thread and turn. Coordinator and executor each persist immutable receipts.

Draft publication also runs on the custody host because that host owns the exact worktree. The coordinator sends only an admitted, non-secret publication plan through a dedicated `<host>-publisher` SSH alias. That alias uses the separate `aubtown-publisher` OS account and `/etc/aubtown/ssh/publisher_ed25519`; the worker alias cannot log in as that account. The corresponding server-side public key must use the checked-in `restrict,command=` template. Its root-owned gateway accepts exactly `probe` or `publish <base64url-payload>`. It rejects shells, executable paths, extra arguments, forwarding, and malformed payloads. Before either operation succeeds, the gateway proves its own digest, the draft publisher digest, root ownership of code and runtime files, the pinned Node and Git binaries, and the publisher-owned key mode. The host-local publisher verifies the selected host and repository, checks the clean committed work product again, and mints a repository-scoped Draft Publisher App token from its own protected key. The token is readable only by the publisher account and never appears in SSH arguments, worker state, or the coordinator environment. The publisher account needs narrowly scoped filesystem access to inspect and push the admitted worktree, but the executor account receives no reciprocal access to publisher credentials.

The completion reconciler now owns the entire draft handoff transaction. It rereads GitHub, current quota, Freed task authority, and the exact claim after independent review. It records the admitted plan before contacting the custody host, records the exact draft receipt, projects `factory:human-review` through the Coordinator App, persists a deterministic `worker-completed` release command, and records the exact broker receipt. Every stage is a separate immutable protected file under `/var/lib/aubtown/admission/publications`. A lost release response replays the same operation ID and payload. A completed transaction exits before requiring the claim or `factory:ready` label again. `AUBTOWN_LIFECYCLE_PROJECTION_ENABLED=false` keeps this entire write path disabled until the owner-selected pilot gate is deliberately enabled.

A failed validation or independent review never publishes a branch or pull request. The coordinator instead records a blocked-handoff plan containing the exact work product, `factory:blocked` projection, and deterministic claim-release command. It projects the blocker through the same single managed comment, then releases the completed worker claim. A restart can reconcile an already-written comment or replay an ambiguously acknowledged release without inventing a second operation.

The optional checkpoint edge runs separately and owns storage credentials. Workers receive encrypted checkpoint bytes and short-lived grants, not bucket credentials.

The `factory-coordinator` broker is a one-shot Go binary beside the canonical
Freed state root. It is not a resident service. Read operations invoke the
pinned Freed CLI without authority. Mutations acquire the installed trusted
nightly coordinator lease, invoke one allowlisted claim command, release the
lease with one exact bounded retry, and exit. Symphony and workers receive
scoped receipts, not authority tokens or direct state-root access.

## Filesystem ownership

- `/opt/aubtown/symphony/<commit>`: immutable pinned Symphony executable
- `/opt/aubtown/releases/<revision>`: immutable AubTown build and hooks
- `/etc/aubtown/WORKFLOW.md`: root-owned reviewed workflow
- `/etc/aubtown/symphony.env`: mode-restricted non-secret paths and secret references
- `/etc/aubtown/freed-broker-profiles/freed-pilot.json`: root-owned Linux broker profile with exact runtime checksums
- `/etc/aubtown/ssh/config`: root-owned worker aliases and host-key policy
- `/etc/aubtown/ssh/worker_ed25519`: coordinator-to-executor private key, mode 0600
- `/etc/aubtown/ssh/publisher_ed25519`: coordinator-to-publisher private key, mode 0600
- `/etc/aubtown/ssh/publisher_authorized_keys`: root-owned server key file containing exactly one restricted forced-command key
- `/etc/aubtown/ssh/known_hosts`: explicit executor and publisher aliases for the enrolled Linux and macOS hosts
- `/etc/aubtown/keys`: coordinator and checkpoint service private credentials, including the mode-0600 `aubtown-symphony` owned Linux host-monitor signing key
- `/etc/aubtown/publisher`: credentials readable only by the dedicated publisher OS account
- `/etc/aubtown/publisher-runtime.json`: root-owned host-local Draft Publisher identity and repository allowlist
- `/var/lib/aubtown/symphony`: coordinator state and `CODEX_HOME`
- `/var/lib/aubtown/admission/publications`: immutable draft, projection, and claim cleanup transaction stages
- `/var/lib/aubtown/coordinator/host-observations.json`: authenticated heartbeat and quota state
- `/var/lib/aubtown/coordinator/planning-snapshot.json`: protected read-only cross-source planning evidence
- `/var/lib/aubtown/coordinator/dispatch-intention.json`: protected deterministic proposal or blockers
- `/var/lib/aubtown/coordinator/pilot-readiness.json`: protected live launch-gate report
- `/var/lib/aubtown/coordinator/executor-readiness.json`: fresh selected-host installation proof
- `/var/lib/aubtown/coordinator/publisher-readiness.json`: fresh dedicated publisher identity and credential-boundary proof
- `/var/lib/aubtown/coordinator/freed-broker-conformance.json`: protected disposable broker proof
- `/var/lib/aubtown/conformance`: disposable broker profile state, never canonical Freed authority
- `/var/lib/aubtown/coordinator/custody-transfer-plan.json`: non-authoritative verified-checkpoint transfer proposal
- `/var/lib/aubtown/admission/candidates`: protected non-authoritative per-issue dispatch requests
- `/var/lib/aubtown/admission/envelopes`: protected per-issue Freed authority and quota envelopes
- `/var/lib/aubtown/admission/receipts`: append-only exact-claim prelaunch receipts
- `/var/lib/aubtown/admission/claim-reconciliation.json`: latest stale-claim reconciliation result
- `/var/lib/aubtown/admission/completions`: immutable completion reconciliation records
- `/var/lib/aubtown/admission/adjudications`: immutable coordinator copies of trusted validation and review results
- `/var/lib/aubtown/workspaces`: per-issue worktrees
- `/var/lib/aubtown/executor/handoffs`: mode-0700 content-addressed executor custody manifests and active-workspace pointers
- `/var/lib/aubtown/checkpoints`: encrypted unpublished-work objects
- `/var/lib/aubtown/logs/symphony`: protected structured logs. Journald remains the system log surface.

On the initial Mac, the equivalent root-owned profile is
`/Library/Application Support/AubTown/freed-broker-profiles/freed-pilot.json`.
Start from `config/repositories/freed-broker-profile.example.json` and replace
every zero digest with the installed file's SHA-256. The profile contains paths
and checksums only. It contains no token or credential. Point it at an immutable
root-owned Freed control checkout, not the mutable executor checkout used to
build product branches.

No service resolves a security-sensitive executable from an interactive shell configuration. Git, Codex, AubTown hooks, and the Symphony executable use reviewed absolute paths.

The Symphony service sets `AUBTOWN_PRELAUNCH_CANDIDATE_ROOT`, `AUBTOWN_PRELAUNCH_ENVELOPE_ROOT`, and `AUBTOWN_PRELAUNCH_RECEIPT_ROOT` to those absolute admission directories. It also receives absolute reviewed paths for the Freed checkout, canonical state root, pinned Node executable, and claim broker. The coordinator may read candidates and envelopes and create receipts. Workers receive none of these paths. A candidate cannot grant authority. Missing, unsafe, or mismatched paths keep the writer closed.

The trusted read-only reconciler first runs AubTown's deterministic assembly boundary over one coherent snapshot. Assembly rejects active-claim and lane count disagreement, pilot concurrency conflicts, stale host heartbeats, missing subscription telemetry, blocked quota, and an intended claim whose host no longer matches the selected route. It then publishes the resulting candidate with the native command below from a mode-0600 JSON file:

```sh
/opt/aubtown/node/bin/node /opt/aubtown/current/dist/cli/reconcile-symphony-candidate.js /var/lib/aubtown/reconciler/dispatch-snapshot.json
```

The command reads `AUBTOWN_PRELAUNCH_CANDIDATE_ROOT`, rejects a symbolic, group-writable, world-writable, oversized, stale, inconsistent, ineligible, route-mismatched, or quota-blocked snapshot, and writes no authority receipt. The source input is transient reconciler state and must be replaced atomically before invocation. The read-only collector gathers GitHub, Freed task, broker claim and work-lane, host-gateway, local ref, pull-request, and worktree evidence, then derives a stable proposed dispatch. Missing, duplicate, foreign-repository, or malformed broker claim evidence fails closed. The proposal cannot become an authority-bearing candidate by itself.

## GitHub authentication

The Coordinator GitHub App reads issues and manages approved lifecycle labels and one status comment. The Draft Publisher App receives repository-scoped contents and pull-request access only for an admitted exact-head plan.

Installation tokens are short-lived. The native refresher writes `/var/lib/aubtown/symphony/secrets/github.token` before startup and every 35 minutes. The reviewed Symphony patch rereads that mode-0600 file for each GitHub request. A static long-lived token in `WORKFLOW.md`, shell history, or a worker environment is prohibited.

## SSH workers

Symphony and AubTown workspace preparation use `/etc/aubtown/ssh/config`. The Linux executor is also represented as an SSH alias because current upstream Symphony switches to an SSH-only worker pool whenever any SSH host is configured. SSH alias names must exactly match the enrolled AubTown host IDs, including `linux-control-1` and `macos-executor-1` in the initial topology.

Start from `config/hosts/ssh_config.example`. Replace both hostnames, install the worker and publisher private keys at mode 0600, and write exact entries for the executor and `<host>-publisher` aliases to the private known-hosts file. Install the matching public key from `config/hosts/publisher_authorized_keys.example` or `config/hosts/publisher_authorized_keys.macos.example`, replacing the revision and key placeholder. Install the matching `deploy/sshd` fragment, validate the effective SSH server configuration, and reload SSH only after preserving a separate administrative session. The publisher key file and SSH fragment must be root-owned and must not be writable by the publisher account. The gateway rejects readiness unless that key file contains exactly one restricted command matching its physical runtime paths. Do not collect or accept host keys inside an unattended service. Verify each fingerprint out of band before installation.

Each alias pins:

- hostname or Tailscale address
- dedicated unprivileged user
- identity file
- expected host key
- batch mode
- connection timeout and keepalive

The readiness probe and the worktree preparer both expand the alias with `ssh -G` before any connection. They reject a symbolic, non-root-owned, group-writable, or world-writable config. They also reject placeholders, password fallback, keyboard-interactive authentication, extra identities, mutable host-key learning, forwarding, connection multiplexing, or missing timeouts. The executor readiness report records the SSH executable and config digests.

The reviewed AubTown patch maps each alias to capabilities. A task labeled or qualified for macOS may route only to the Mac alias. Runtime-neutral work may route to either eligible host.

## Workspace creation

Symphony names workspaces by GitHub issue identifier. Before admitting launch, AubTown encodes one claim-bound initial-workspace requirement and sends it through the selected Symphony SSH alias to a fixed remote command. The command reads a protected host-local `/etc/aubtown/worker-runtime.json`, verifies the host ID and repository identity, and invokes Freed's physical `scripts/worktree-add.sh` with:

- a deterministic host-local path
- a hygienic branch name with no authorship giveaway
- fresh `origin/dev`
- the qualified target
- `--swarm` during deferred bootstrap

After the worktree passes exact verification, the command writes an immutable custody manifest and an atomic active-workspace pointer under the configured `handoffRoot`. The handoff binds the exact qualification, task revision, claim, account, driver, branch, base head, owned paths, and draft-only publication ceiling. The request time is excluded from the content digest, so an exact retry remains idempotent. Admission returns only after that command reports the exact claim, host, worktree, branch, and base head. Symphony then finds the prepared directory at its normal `GH-<issue>` path. Its `before_run` guard verifies that the directory is a clean worktree belonging to the enrolled Freed repository and that the branch obeys publication naming policy. No AubTown worker daemon or workspace polling loop is involved.

The `completion` hook invokes `complete-symphony-workspace.js` on the selected executor after Codex succeeds. It rejects a foreign or stale handoff, commits only qualified paths, and writes `completion-<manifest-digest>.json` under the private handoff root. A second invocation returns the original receipt. A later worker retry fails in `before_run` before app-server startup. This hook does not receive a GitHub token and does not publish a branch or pull request.

If Symphony ever creates an empty fallback directory, its `after_create` guard fails immediately and removes it. This turns a missing host preparation into a block instead of silently running Codex in an empty directory. Bare `git worktree add` in production and direct workspace copying are prohibited.

## Bring-up sequence

1. Provision Linux, persistent storage, firewall rules, and Tailscale.
2. Create dedicated coordinator, checkpoint, and executor users. The MVP token refresher uses the restricted coordinator identity. A later broker split must preserve mode-0600 delivery without widening access.
3. Install reviewed absolute Git, Node, Codex, SSH, and certificate paths.
4. Install the pinned Symphony source or binary and verify its checksum.
5. Install the reviewed AubTown build, `dist/factory-coordinator`, its root-owned broker profile, and native service units, including the GitHub token refresh timer, signed host observation gateway, read-only planning timer, and claim reconciliation timer.
6. Install the same reviewed AubTown release on each executor, check out Freed, create its handoff root at mode 0700, write the protected worker, reviewer, and publisher runtime configs, and verify `scripts/worktree-add.sh` at the configured physical path. Use `config/hosts/worker-runtime.example.json`, `config/hosts/reviewer-runtime.example.json`, and `config/hosts/publisher-runtime.example.json` for Linux. Use the matching `.macos.example.json` files for macOS.
7. Authenticate the dedicated Codex account into the coordinator's private `CODEX_HOME`.
8. Install the GitHub Apps on Freed and provision their private keys to the appropriate brokers.
9. Install the Symphony workflow and the root-owned SSH configuration, identity, and independently verified known-host keys.
10. Run the read-only upstream, host, quota, issue, task, branch, and workspace checks, then invoke the native publisher for one protected non-authoritative candidate.
11. Run the fake worker, exact-claim restart, concurrent prelaunch, rolling-week, daily ceiling, and Mac-offline Linux routing proofs.
12. Install `/etc/aubtown/freed-broker-conformance.json` from `config/repositories/freed-broker-conformance.example.json`, map its `conformance-*` profile to disposable state, provision its actor launchers under `/etc/freed/automation-actor-launchers-conformance`, then run `systemctl start aubtown-freed-broker-conformance.service`.
13. Set `AUBTOWN_PILOT_EXECUTOR_HOST_ID` to the host selected by the protected dispatch, run `systemctl start aubtown-pilot-readiness.service`, and inspect the broker, executor, and pilot reports.
14. Keep the writer disabled until the audit is ready and the real Freed task-claim integration test passes.

## macOS executor

The Mac needs no coordinator and no Docker runtime. It provides SSH, Codex, the Freed checkout, `scripts/worktree-add.sh`, its private `CODEX_HOME`, native toolchains, a host-owned workspace root, and the private handoff root in `config/hosts/worker-runtime.macos.example.json`.

For draft publication, the Mac also keeps its own host-local Draft Publisher App key and protected `publisher-runtime.json` under the separate `aubtown-publisher` account. The executor account cannot read this credential, and the credential is never transferred from Linux.

When the Mac sleeps or disconnects, it stops receiving work. Linux continues. An unpublished Mac task remains claimed until it returns or the 24-hour checkpoint-backed transfer policy advances custody to a compatible host.

## Service verification

Before enabling a writer, verify:

- service runs as the intended unprivileged user
- dashboard listens only on loopback
- host observation gateway listens only on loopback and rejects unsigned, stale, conflicting, or out-of-scope envelopes
- workflow and executable match reviewed digests
- GitHub token refresh succeeds without reaching the worker environment
- both SSH aliases verify pinned host keys
- the expanded SSH aliases pass AubTown policy with passwords, forwarding, and multiplexing disabled
- Codex reports the expected account, callable model, and rate-limit windows
- restart does not duplicate a fake issue
- daily and rolling-week stops reject new fake dispatches
- the active Symphony run loop interrupts at the hard quota boundary before unattended operation
- the active guard marks and heartbeats running custody, an expired unlaunched claim is released, and a stale running claim remains fenced
- a new reconciled authority claim can proceed without deleting the prior crash receipt
- the native pilot audit reports ready for the exact selected issue and installed immutable release
- the selected executor report is fresh and matches the dispatch host, repository, workspace root, and exact base head
- the selected executor report binds the installed workspace preparer, trusted completion, completion reader, and trusted adjudicator digests
- a fake completion creates one exact commit and receipt, while a second invocation remains idempotent
- a fake completion reconciliation rejects stale authority and substituted custody, resumes one durable review handle after restart, and interrupts review at the quota ceiling
- the disposable broker report proves all named lifecycle checks against the exact installed executable digest
- no container runtime is running or required

Provider-specific provisioning may use Terraform or OpenTofu later. Hosting APIs do not belong in the scheduler or authority domain.
