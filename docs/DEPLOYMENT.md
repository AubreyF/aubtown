# Deployment contract

Status: native deployment skeleton, writer disabled

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

## Service graph

`aubtown-symphony.service` runs the one scheduler and dashboard as `aubtown-symphony`. It binds the dashboard to `127.0.0.1:7080`. Tailscale may expose that loopback service privately. Never bind it to a public interface.

The pinned Symphony runner invokes `dist/cli/symphony-active-run-guard.js` every 30 seconds while a Codex turn is active. The guard reads the same protected admission envelope, host enrollment, heartbeat, and rolling-week account journal used by prelaunch. An exact hard-limit response sends `turn/interrupt` for that thread and turn. If cancellation does not finish within five seconds, Symphony closes the app-server transport.

`aubtown-github-token.timer` refreshes the Coordinator GitHub App installation token every 35 minutes. The one-shot refresher runs before Symphony starts, reads the host-side private key, and atomically replaces a mode-0600 token file. The initial native deployment uses the same restricted OS identity for the refresher and coordinator because Symphony must read that file. The private key remains outside Symphony's workflow and worker environments.

`aubtown-host-gateway.service` receives signed heartbeat and quota envelopes as `aubtown-symphony`. It binds to `127.0.0.1:8090`, persists `/var/lib/aubtown/coordinator/host-observations.json`, and reads only enrolled public keys from `/etc/aubtown/hosts.json`. A Mac reaches it through a private Tailscale HTTPS forward. Do not bind it publicly. Execution, workspace, restore, checkpoint, validation, and review commands remain closed until their coordinator state machines and the Freed claim path are enabled.

`aubtown-host-agent.service` currently runs `dist/host-monitor.js`. Despite the legacy unit filename, this process only reads Codex rate limits and cumulative token activity, then sends signed heartbeat and quota observations. If either required meter is missing or invalid, it fails closed instead of dispatching from partial telemetry. It does not run AubTown's optional executor, workspace, validation, checkpoint, or adjudication supervisors. Symphony owns execution.

`aubtown-planning-snapshot.timer` invokes a native one-shot collector once per minute. The collector reads GitHub, the supported Freed task command, signed host state, local Git refs, and local worktrees. It atomically replaces `/var/lib/aubtown/coordinator/planning-snapshot.json` and `/var/lib/aubtown/coordinator/dispatch-intention.json`. The second file contains either one deterministic proposed initial dispatch or explicit blockers. These files are read-only planning evidence. Neither is an execution claim, candidate, queue, or launch authority.

`aubtown-pilot-readiness.service` is a manual, read-only launch gate. It runs only after a fresh planning collection. Its preflight probes the selected executor through the configured Symphony SSH alias and writes `/var/lib/aubtown/coordinator/executor-readiness.json`. The probe verifies the protected worker config, physical Freed checkout, writable workspace root, exact `origin/dev` head, pinned Node and Git runtimes, physical worktree helper, and immutable workspace preparer. The audit then verifies that fresh report against the selected host, repository, workspace root, and dispatch base head. It also verifies protected coordinator runtime files, the immutable Symphony executable path, every reviewed patch digest, the workflow policy, prelaunch and active-guard builds, the installed Freed claim broker, a planning snapshot no older than 90 seconds, and one coherent ready dispatch for the configured repository and issue. It writes `/var/lib/aubtown/coordinator/pilot-readiness.json` and exits nonzero when any check fails. A blocked report is evidence, not permission to weaken the check.

`aubtown-claim-reconciliation.timer` runs the native claim reconciler every minute. The same command runs as Symphony's `ExecStartPre` with `--require-clear`. An active guard heartbeat no older than 120 seconds or a claim inside its initial five-minute grace keeps custody intact. Older unlaunched `claimed` records are released through the broker with the exact last heartbeat, task revision, claim, binding, and custody epoch. If a heartbeat races that release, the broker rejects it and Symphony remains stopped. Stale `running` records are never released by age. They remain fenced for workspace restart or checkpoint transfer. This service needs only the broker endpoint and its own report file. It does not read or edit Freed authority files.

`aubtown-freed-broker-conformance.service` runs immediately before pilot readiness against a disposable `conformance-*` broker profile. Each operation starts a separate broker process. The gate checks acquire, exact replay, changed-replay rejection, claim projection, duplicate rejection, heartbeat, checkpoint-backed transfer, stale-epoch fencing, exact release, and post-release restart state. Its protected report binds the exact broker path and SHA-256 digest. Pilot readiness accepts only a complete passing report from the last 10 minutes for the executable it is about to trust.

The optional checkpoint edge runs separately and owns storage credentials. Workers receive encrypted checkpoint bytes and short-lived grants, not bucket credentials.

The future authority broker runs under its own service identity beside the canonical Freed state root. Symphony and workers receive scoped receipts, not authority tokens or direct state-root access.

## Filesystem ownership

- `/opt/aubtown/symphony/<commit>`: immutable pinned Symphony executable
- `/opt/aubtown/releases/<revision>`: immutable AubTown build and hooks
- `/etc/aubtown/WORKFLOW.md`: root-owned reviewed workflow
- `/etc/aubtown/symphony.env`: mode-restricted non-secret paths and secret references
- `/etc/aubtown/ssh/config`: root-owned worker aliases and host-key policy
- `/etc/aubtown/keys`: service-specific private credentials
- `/var/lib/aubtown/symphony`: coordinator state and `CODEX_HOME`
- `/var/lib/aubtown/coordinator/host-observations.json`: authenticated heartbeat and quota state
- `/var/lib/aubtown/coordinator/planning-snapshot.json`: protected read-only cross-source planning evidence
- `/var/lib/aubtown/coordinator/dispatch-intention.json`: protected deterministic proposal or blockers
- `/var/lib/aubtown/coordinator/pilot-readiness.json`: protected live launch-gate report
- `/var/lib/aubtown/coordinator/executor-readiness.json`: fresh selected-host installation proof
- `/var/lib/aubtown/coordinator/freed-broker-conformance.json`: protected disposable broker proof
- `/var/lib/aubtown/conformance`: disposable broker profile state, never canonical Freed authority
- `/var/lib/aubtown/coordinator/custody-transfer-plan.json`: non-authoritative verified-checkpoint transfer proposal
- `/var/lib/aubtown/admission/candidates`: protected non-authoritative per-issue dispatch requests
- `/var/lib/aubtown/admission/envelopes`: protected per-issue Freed authority and quota envelopes
- `/var/lib/aubtown/admission/receipts`: append-only exact-claim prelaunch receipts
- `/var/lib/aubtown/admission/claim-reconciliation.json`: latest stale-claim reconciliation result
- `/var/lib/aubtown/workspaces`: per-issue worktrees
- `/var/lib/aubtown/checkpoints`: encrypted unpublished-work objects
- `/var/log/aubtown/symphony`: structured logs

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

Each alias must pin:

- hostname or Tailscale address
- dedicated unprivileged user
- identity file
- expected host key
- batch mode
- connection timeout and keepalive

The reviewed AubTown patch maps each alias to capabilities. A task labeled or qualified for macOS may route only to the Mac alias. Runtime-neutral work may route to either eligible host.

## Workspace creation

Symphony names workspaces by GitHub issue identifier. Before admitting launch, AubTown encodes one claim-bound initial-workspace requirement and sends it through the selected Symphony SSH alias to a fixed remote command. The command reads a protected host-local `/etc/aubtown/worker-runtime.json`, verifies the host ID and repository identity, and invokes Freed's physical `scripts/worktree-add.sh` with:

- a deterministic host-local path
- a hygienic branch name with no authorship giveaway
- fresh `origin/dev`
- the qualified target
- `--swarm` during deferred bootstrap

Admission returns only after that command reports the exact claim, host, worktree, branch, and base head. Symphony then finds the prepared directory at its normal `GH-<issue>` path. Its `before_run` guard verifies that the directory is a clean worktree belonging to the enrolled Freed repository and that the branch obeys publication naming policy. No AubTown worker daemon or workspace polling loop is involved.

If Symphony ever creates an empty fallback directory, its `after_create` guard fails immediately and removes it. This turns a missing host preparation into a block instead of silently running Codex in an empty directory. Bare `git worktree add` in production and direct workspace copying are prohibited.

## Bring-up sequence

1. Provision Linux, persistent storage, firewall rules, and Tailscale.
2. Create dedicated coordinator, checkpoint, and executor users. The MVP token refresher uses the restricted coordinator identity. A later broker split must preserve mode-0600 delivery without widening access.
3. Install reviewed absolute Git, Node, Codex, SSH, and certificate paths.
4. Install the pinned Symphony source or binary and verify its checksum.
5. Install the reviewed AubTown build and native service units, including the GitHub token refresh timer, signed host observation gateway, read-only planning timer, and claim reconciliation timer.
6. Install the same reviewed AubTown release on each executor, check out Freed, write the protected worker runtime config, and verify `scripts/worktree-add.sh` at the configured physical path.
7. Authenticate the dedicated Codex account into the coordinator's private `CODEX_HOME`.
8. Install the GitHub Apps on Freed and provision their private keys to the appropriate brokers.
9. Install the Symphony workflow and SSH configuration.
10. Run the read-only upstream, host, quota, issue, task, branch, and workspace checks, then invoke the native publisher for one protected non-authoritative candidate.
11. Run the fake worker, exact-claim restart, concurrent prelaunch, rolling-week, daily ceiling, and Mac-offline Linux routing proofs.
12. Install `/etc/aubtown/freed-broker-conformance.json` from `config/repositories/freed-broker-conformance.example.json`, map its `conformance-*` profile to disposable state, then run `systemctl start aubtown-freed-broker-conformance.service`.
13. Set `AUBTOWN_PILOT_EXECUTOR_HOST_ID` to the host selected by the protected dispatch, run `systemctl start aubtown-pilot-readiness.service`, and inspect the broker, executor, and pilot reports.
14. Keep the writer disabled until the audit is ready and the real Freed task-claim integration test passes.

## macOS executor

The Mac needs no coordinator and no Docker runtime. It provides SSH, Codex, the Freed checkout, `scripts/worktree-add.sh`, its private `CODEX_HOME`, native toolchains, and a host-owned workspace root.

When the Mac sleeps or disconnects, it stops receiving work. Linux continues. An unpublished Mac task remains claimed until it returns or the 24-hour checkpoint-backed transfer policy advances custody to a compatible host.

## Service verification

Before enabling a writer, verify:

- service runs as the intended unprivileged user
- dashboard listens only on loopback
- host observation gateway listens only on loopback and rejects unsigned, stale, conflicting, or out-of-scope envelopes
- workflow and executable match reviewed digests
- GitHub token refresh succeeds without reaching the worker environment
- both SSH aliases verify pinned host keys
- Codex reports the expected account, callable model, and rate-limit windows
- restart does not duplicate a fake issue
- daily and rolling-week stops reject new fake dispatches
- the active Symphony run loop interrupts at the hard quota boundary before unattended operation
- the active guard marks and heartbeats running custody, an expired unlaunched claim is released, and a stale running claim remains fenced
- a new reconciled authority claim can proceed without deleting the prior crash receipt
- the native pilot audit reports ready for the exact selected issue and installed immutable release
- the selected executor report is fresh and matches the dispatch host, repository, workspace root, and exact base head
- the disposable broker report proves all named lifecycle checks against the exact installed executable digest
- no container runtime is running or required

Provider-specific provisioning may use Terraform or OpenTofu later. Hosting APIs do not belong in the scheduler or authority domain.
