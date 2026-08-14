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

`aubtown-github-token.timer` refreshes the Coordinator GitHub App installation token every 35 minutes. The one-shot refresher runs before Symphony starts, reads the host-side private key, and atomically replaces a mode-0600 token file. The initial native deployment uses the same restricted OS identity for the refresher and coordinator because Symphony must read that file. The private key remains outside Symphony's workflow and worker environments.

`aubtown-host-gateway.service` receives signed heartbeat and quota envelopes as `aubtown-symphony`. It binds to `127.0.0.1:8090`, persists `/var/lib/aubtown/coordinator/host-observations.json`, and reads only enrolled public keys from `/etc/aubtown/hosts.json`. A Mac reaches it through a private Tailscale HTTPS forward. Do not bind it publicly. Execution, workspace, restore, checkpoint, validation, and review commands remain closed until their coordinator state machines and the Freed claim path are enabled.

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
- `/var/lib/aubtown/admission/candidates`: protected non-authoritative per-issue dispatch requests
- `/var/lib/aubtown/admission/envelopes`: protected per-issue Freed authority and quota envelopes
- `/var/lib/aubtown/admission/receipts`: append-only exact-claim prelaunch receipts
- `/var/lib/aubtown/workspaces`: per-issue worktrees
- `/var/lib/aubtown/checkpoints`: encrypted unpublished-work objects
- `/var/log/aubtown/symphony`: structured logs

No service resolves a security-sensitive executable from an interactive shell configuration. Git, Codex, AubTown hooks, and the Symphony executable use reviewed absolute paths.

The Symphony service sets `AUBTOWN_PRELAUNCH_CANDIDATE_ROOT`, `AUBTOWN_PRELAUNCH_ENVELOPE_ROOT`, and `AUBTOWN_PRELAUNCH_RECEIPT_ROOT` to those absolute admission directories. It also receives absolute reviewed paths for the Freed checkout, canonical state root, pinned Node executable, and claim broker. The coordinator may read candidates and envelopes and create receipts. Workers receive none of these paths. A candidate cannot grant authority. Missing, unsafe, or mismatched paths keep the writer closed.

The trusted read-only reconciler first runs AubTown's deterministic assembly boundary over one coherent snapshot. Assembly rejects active-claim and lane count disagreement, pilot concurrency conflicts, stale host heartbeats, missing subscription telemetry, blocked quota, and an intended claim whose host no longer matches the selected route. It then publishes the resulting candidate with the native command below from a mode-0600 JSON file:

```sh
/opt/aubtown/node/bin/node /opt/aubtown/current/dist/cli/reconcile-symphony-candidate.js /var/lib/aubtown/reconciler/dispatch-snapshot.json
```

The command reads `AUBTOWN_PRELAUNCH_CANDIDATE_ROOT`, rejects a symbolic, group-writable, world-writable, oversized, stale, inconsistent, ineligible, route-mismatched, or quota-blocked snapshot, and writes no authority receipt. The source input is transient reconciler state and must be replaced atomically before invocation. The current repository ships this command, but live GitHub, Freed, host-gateway, and Git-head snapshot collection remains disabled until the Freed claim side is installed.

## GitHub authentication

The Coordinator GitHub App reads issues and manages approved lifecycle labels and one status comment. The Draft Publisher App receives repository-scoped contents and pull-request access only for an admitted exact-head plan.

Installation tokens are short-lived. The native refresher writes `/var/lib/aubtown/symphony/secrets/github.token` before startup and every 35 minutes. The reviewed Symphony patch rereads that mode-0600 file for each GitHub request. A static long-lived token in `WORKFLOW.md`, shell history, or a worker environment is prohibited.

## SSH workers

Symphony uses `/etc/aubtown/ssh/config`. The Linux executor is also represented as an SSH alias because current upstream Symphony switches to an SSH-only worker pool whenever any SSH host is configured.

Each alias must pin:

- hostname or Tailscale address
- dedicated unprivileged user
- identity file
- expected host key
- batch mode
- connection timeout and keepalive

The reviewed AubTown patch maps each alias to capabilities. A task labeled or qualified for macOS may route only to the Mac alias. Runtime-neutral work may route to either eligible host.

## Workspace creation

Symphony names workspaces by GitHub issue identifier. Before admitting launch, AubTown gives the selected host one claim-bound initial-workspace requirement. The host workspace supervisor invokes Freed's physical `scripts/worktree-add.sh` with:

- a deterministic host-local path
- a hygienic branch name with no authorship giveaway
- fresh `origin/dev`
- the qualified target
- `--swarm` during deferred bootstrap

Admission returns only after the host reports the exact clean branch and base head. Symphony then finds the prepared directory. Its `before_run` guard verifies that the directory is a clean worktree belonging to the enrolled Freed repository and that the branch obeys publication naming policy.

If Symphony ever creates an empty fallback directory, its `after_create` guard fails immediately and removes it. This turns a missing host preparation into a block instead of silently running Codex in an empty directory. Bare `git worktree add` in production and direct workspace copying are prohibited.

## Bring-up sequence

1. Provision Linux, persistent storage, firewall rules, and Tailscale.
2. Create dedicated coordinator, checkpoint, and executor users. The MVP token refresher uses the restricted coordinator identity. A later broker split must preserve mode-0600 delivery without widening access.
3. Install reviewed absolute Git, Node, Codex, SSH, and certificate paths.
4. Install the pinned Symphony source or binary and verify its checksum.
5. Install the reviewed AubTown build and native service units, including the GitHub token refresh timer and signed host observation gateway.
6. Check out Freed and verify `scripts/worktree-add.sh` at the expected path.
7. Authenticate the dedicated Codex account into the coordinator's private `CODEX_HOME`.
8. Install the GitHub Apps on Freed and provision their private keys to the appropriate brokers.
9. Install the Symphony workflow and SSH configuration.
10. Run the read-only upstream, host, quota, issue, task, branch, and workspace checks, then invoke the native publisher for one protected non-authoritative candidate.
11. Run the fake worker, exact-claim restart, concurrent prelaunch, rolling-week, daily ceiling, and Mac-offline Linux routing proofs.
12. Keep the writer disabled until the Freed task-claim integration test passes.

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
- a new reconciled authority claim can proceed without deleting the prior crash receipt
- no container runtime is running or required

Provider-specific provisioning may use Terraform or OpenTofu later. Hosting APIs do not belong in the scheduler or authority domain.
