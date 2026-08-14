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
- Daily and rolling-week Codex quota policy
- Driver-neutral account and host routing contracts
- GitHub App token brokerage and draft-only publication planning
- Exact-head validation and fresh-review handoff contracts
- Encrypted, content-addressed unpublished-work checkpoints
- Custody epochs, restoration, and stale-host fencing
- Host-signed receipts and replay protection
- GitHub status projection and optional standby-coordinator comment election
- A pinned Symphony production and upstream-tracking contract
- Fail-closed Symphony prelaunch admission and capability-aware host routing
- Fail-closed active-turn quota checks with exact thread and turn interruption
- Append-only exact-claim prelaunch receipts that survive coordinator restart
- A no-shell Freed claim broker caller with exact response-loss retry and protected envelope handoff
- A native protected non-authoritative dispatch-candidate publisher with matching-envelope reuse
- A native deterministic reconciler CLI across conflict, host, account, route, and quota state
- A native signed host observation gateway with durable heartbeat and quota state
- A lightweight host telemetry process that does not run a second scheduler or worker loop
- A native minute-by-minute protected planning snapshot across GitHub, Freed task, host, quota, ref, pull-request, and worktree evidence
- A deterministic dispatch-intention builder that derives one host, account, branch, worktree, target, and initial claim without granting authority
- A Freed workflow that accepts only helper-prepared, policy-safe worktrees

The checked-in Symphony prelaunch executable resolves a protected dispatch candidate before launch. A candidate is a request, not authority. The native publisher rejects unsafe files, stale claims, incompatible routes, ineligible work, and blocked daily or rolling-week quota before writing the request. Prelaunch checks freshness again before any broker call. An unchanged candidate may reuse its matching protected envelope. A changed candidate must acquire a new exact Freed claim through the reviewed host broker before AubTown publishes a replacement envelope. The final boundary then checks fresh quota and atomically records the exact claim, so a restart or concurrent process cannot admit it twice. While a turn is active, Symphony runs AubTown's guard every 30 seconds against the protected live host and account journal. A hard quota result interrupts the exact thread and turn, then closes the app-server transport if cancellation does not finish within five seconds. The live collector assembles read-only source evidence and a deterministic proposed dispatch, but it deliberately reports incomplete claim evidence. The real writer remains disabled because Freed's task-claim commands are not wired yet. Passing tests does not authorize a live issue or GitHub write.

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
