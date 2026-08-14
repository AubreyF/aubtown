# AubTown

AubTown is a Freed-first software factory. GitHub Issues are its canonical queue, Freed remains the execution authority, and a reviewed OpenAI Symphony build runs the scheduling and Codex sessions.

## Pilot contract

- One active Symphony coordinator runs on Linux.
- Linux and intermittent macOS machines are worker hosts under that coordinator.
- Only open `debt` issues carrying `factory:ready` are eligible for the pilot.
- An eligible issue must also have a matching active Freed task and task-scoped execution claim.
- Runtime-neutral work may run on either compatible host. Native work requires macOS.
- Provider-visible, release, signing, deployment, secrets, migration, recovery, relay, sync, and authentication work remain unattended-ineligible.
- The highest autonomous publication is one draft pull request.
- GitHub shows lifecycle state through one `factory:*` label and one machine-managed status comment.
- AubTown does not rewrite issue descriptions and does not create a second backlog.
- Production runs natively. Restate, Docker, and Compose are not part of the architecture.

Symphony is pinned by immutable commit and source checksum in `upstream/symphony.lock.json`. `npm run check:symphony:upstream` observes upstream changes without silently deploying them.

## What is implemented

- Deterministic read-only qualification and conflict-domain derivation
- Reset-safe daily and rolling-week Codex quota policy with cumulative token cross-checks
- Driver-neutral account and host routing contracts
- GitHub App token brokerage and draft-only publication planning
- Exact-head validation and fresh-review handoff contracts
- Encrypted, content-addressed unpublished-work checkpoints
- Custody epochs, restoration, and stale-host fencing
- Deterministic 24-hour offline transfer plans backed by verified checkpoint receipts
- Host-signed receipts and replay protection
- GitHub status projection and optional standby-coordinator comment election
- A pinned Symphony production and upstream-tracking contract
- Fail-closed Symphony prelaunch admission and capability-aware host routing
- Fail-closed active-turn quota checks with exact thread and turn interruption
- Append-only exact-claim prelaunch receipts that survive coordinator restart
- A no-shell Freed claim broker caller with exact response-loss retry and protected envelope handoff
- A native protected non-authoritative dispatch-candidate publisher with matching-envelope reuse
- A native deterministic reconciler CLI across conflict, host, account, route, and quota state
- Complete broker-backed active-claim and work-lane evidence for concurrency decisions
- Active-turn claim stages and heartbeats with race-safe unlaunched crash recovery
- A native signed host observation gateway with durable heartbeat and quota state
- A lightweight host telemetry process that does not run a second scheduler or worker loop
- A native minute-by-minute protected planning snapshot across GitHub, Freed task, host, quota, ref, pull-request, and worktree evidence
- A deterministic dispatch-intention builder that derives one host, account, branch, worktree, target, and initial claim without granting authority
- A native fail-closed pilot audit over the installed pin, patch digests, runtime files, authority broker, planning evidence, and exact dispatch identity
- Claim-bound remote workspace preparation through Symphony's existing SSH lane and Freed's physical worktree helper
- A content-addressed executor handoff that binds the exact claim, qualification, authority task, account, driver, workspace, draft-only ceiling, and trusted finalization nonce
- A required Symphony completion hook that creates one owned-path candidate commit and immutable receipt before reporting worker success
- A pre-run fence that blocks another Codex turn when the workspace already has a trusted completion receipt
- Coordinator reconciliation that binds the completion receipt to fresh GitHub, Freed task, claim, quota, and implementation-turn evidence
- Exact validation and fresh read-only independent review on the custody host, with active rolling-week quota interruption and restart-safe receipts
- A fresh selected-executor probe for the pinned Node and Git runtimes, Freed checkout, helper, workspace root, private handoff root, preparer, completion, reader, and adjudicator digests, and admitted base ref
- A forced-command publisher SSH account that admits only readiness probes and exact draft publication payloads
- A fresh dedicated-publisher probe for its OS identity, private key mode, pinned runtime, gateway, worktree roots, repository enrollment, and draft publisher digest
- Machine-checked OpenSSH worker aliases with pinned host keys, one identity, no password fallback, and no forwarding
- A Freed workflow that accepts only helper-prepared, policy-safe worktrees

The checked-in Symphony prelaunch executable resolves a protected dispatch candidate before launch. A candidate is a request, not authority. The native publisher rejects unsafe files, stale claims, incompatible routes, ineligible work, and blocked daily or rolling-week quota before writing the request. Prelaunch checks freshness again before any broker call. An unchanged candidate may reuse its matching protected envelope. A changed candidate must acquire a new exact Freed claim through the reviewed host broker. AubTown then prepares the exact `GH-<issue>` worktree on the selected executor through Symphony's SSH alias. The remote preparer writes a content-addressed custody manifest and an atomic active-workspace pointer before returning its exact receipt. Neither file contains a credential or grants authority. The final boundary checks fresh quota and records the exact claim, so a restart or concurrent process cannot admit it twice. While a turn is active, Symphony runs AubTown's guard every 30 seconds against the protected live host and account journal. A hard quota result interrupts the exact thread and turn, then closes the app-server transport if cancellation does not finish within five seconds. After Codex succeeds, Symphony requires the trusted completion hook. The hook verifies the same handoff, commits only qualified paths, and records one immutable completion receipt. It does not receive publication credentials. A retry is fenced before Codex if that receipt already exists. The coordinator then rereads the issue, Freed task, exact claim, host turn, and quota state. It asks the custody host to validate the immutable patch and run a separate read-only reviewer context. The reviewer uses its own `CODEX_HOME`, checks the configured model at use time, and is interrupted if the rolling-week or daily limit crosses a hard boundary. Immutable reconciliation and adjudication receipts make the completed result restart-safe. An admitted non-secret draft plan returns to the custody host through a dedicated publisher SSH and OS identity, where a trusted local process uses its own Draft Publisher App key without exposing credentials to the worker or coordinator. The coordinator records immutable plan, draft, projection, release-command, and release receipts. A restart reuses the exact stage or replays the deterministic release command. Failed adjudication records a separate blocked projection and exact cleanup transaction without publishing anything. The write path remains disabled until the lifecycle projection pilot gate is explicitly enabled. Freed draft PR #1491 supplies the task-claim contract, and AubTown builds the one-shot host broker that invokes it without exposing coordinator credentials. The real writer remains disabled until review, installation, disposable conformance, and the owner-selected pilot pass. Passing tests does not authorize a live issue or GitHub write.

## Development

Use Node 24.14.1 or newer from the repository-pinned toolchain.

```sh
npm install
npm run check
npm run build
npm run check:symphony
```

Read-only shadow qualification:

```sh
npm run shadow
```

No development command requires Docker Desktop.

## Repository map

- `src/policy`: qualification, quota, routing, conflict, reconciliation, and custody policy
- `src/adapters`: GitHub and Freed boundaries
- `src/credentials`: repository-scoped GitHub App token broker
- `src/checkpoints`: encrypted custody format and storage adapters
- `src/execution`: host-local execution, finalization, and receipt journals
- `src/publication`: exact-head draft publication boundary
- `src/coordination`: optional GitHub comment election for standby coordinator promotion
- `upstream`: Symphony pin, audit notes, and future reviewed patch series
- `deploy`: native systemd and launchd templates
- `docs`: architecture, authority, threat model, deployment, custody, and phase gates
