# Architecture

## Governing rule

GitHub Issues are the only backlog. Restate owns durable scheduling state. A repository authority adapter decides whether work may execute. Neither Restate state nor a GitHub label can replace repository authority.

For Freed, dispatch requires all of these conditions:

1. The issue is open and labeled `debt` and `factory:ready`.
2. The issue is not labeled `automation-triage`.
3. Qualification contains one root cause, current evidence, bounded scope, acceptance criteria, exact validation, and conflict ownership.
4. A live Freed control task references the exact issue number and URL.
5. A worker-specific trusted launcher grants the matching short-lived lease.
6. Subscription, host, conflict, provider, owner-review, and publication policies admit the work.

## Portable kernel

The portable kernel contains only deterministic contracts:

- issue qualification and priority
- conflict domains and lane caps
- subscription admission and routing
- host selection
- custody epoch fencing
- publication ceilings
- claim identity and lifecycle

External systems implement narrow interfaces:

- tracker adapter
- repository authority adapter
- worker driver
- workspace driver
- credential broker
- checkpoint store
- notification sink
- hosting deployment

This separation permits a later Grok or other API driver without changing issue authority, claims, conflict control, custody, or publication policy. A future OpenHands driver has the same boundary. It is not part of the initial writer path.

## Durable orchestration

Restate is the initial durable runtime. The `ClaimRegistry` virtual object serializes mutations for one repository and issue key. A custody transfer must advance exactly one epoch. The `QualificationWorkflow` stores its report and terminal qualification stage.

Restate state is operational state, not a second backlog. A startup reconciler compares durable claims against GitHub, Freed tasks, leases, branches, worktrees, and pull requests before dispatch or retry.

The production deployment pins Restate 1.7.3 and TypeScript SDK 1.16.5. The server data directory lives on durable storage. Upgrades are reviewed and pinned.

References:

- [Restate 1.7.3 release](https://github.com/restatedev/restate/releases/tag/v1.7.3)
- [Restate TypeScript services](https://docs.restate.dev/develop/ts/services)
- [Restate single-node Docker deployment](https://docs.restate.dev/server/deploy/docker)

## Hosts

`linux-control-1` owns the durable runtime and generic Linux execution. `macos-executor-1` is an intermittent specialist for native macOS, Tauri, install, and soak work. Its absence does not stop portable work.

Each executor has one local Codex profile and one host identity. Credentials never move between hosts. Future subscription scaling assigns each subscription to an isolated executor profile. The scheduler routes claims to published capacity and quota headroom. It never logs one process into a carousel of copied account files.

## Quota

The governor samples Codex app-server every 60 seconds and listens for rate-limit updates. It searches the primary, secondary, and multi-bucket views for the actual 10,080 minute window. It fails closed if app-server does not expose that rolling weekly window. It never assumes the field named `primary` is weekly.

- Autonomous weekly ceiling: 80 percent
- Reserved capacity: 20 percent
- Daily throttle: 7 percentage points
- Daily admission stop: 9 percentage points
- Daily interrupt: 10 percentage points
- Stale telemetry: interrupt after 120 seconds

The daily value is the increase from the Los Angeles day baseline within the same rolling window. A window reset begins a new baseline. Manual usage on the account reduces factory headroom. Earned reset credits are never consumed automatically.

Codex telemetry and interruption use the documented `account/rateLimits/read`, `account/usage/read`, and `turn/interrupt` app-server methods. See [Codex app-server](https://developers.openai.com/codex/app-server).

The worker driver and usage source are separate interfaces. A future metered API driver can report a money or token budget through another usage source without changing claims, routing, custody, authority, or publication. Multiple subscriptions remain isolated by host profile. Routing chooses an enabled host and account with measured headroom. Credentials never migrate with work.

## Repository adapters

The portable admission report is intentionally uniform across repositories. Each repository supplies a stricter authority adapter underneath it. Freed's adapter requires the exact canonical task, trusted launcher, worker lease, global behavior slot, provider gates, installed outcome, and soak contracts. A simpler future repository can implement a smaller authority control plane, but it cannot bypass the common issue, claim, quota, custody, conflict, and publication invariants.

The initial Freed bridge remains fail-closed until the authority extension in [FREED-AUTHORITY-BRIDGE.md](FREED-AUTHORITY-BRIDGE.md) is approved and implemented. It will not repurpose `nightly-writer`. Freed owns the task-claim command and receipt schemas. The private operations repository owns the scheduler and host broker implementation.

## Custody

Every successful mutating turn and planned shutdown creates an encrypted checkpoint. Checkpoints include Git state, approved untracked files, validation receipts, and custody metadata. They exclude credentials, ignored files, dependencies, arbitrary untracked files, and authentication caches.

An offline host triggers alerts at 1 hour and 12 hours. At 24 hours, portable work may transfer to an online compatible host. The coordinator durably increments the custody epoch before the destination resumes. A returning stale host is quarantined until it proves it has no current claim.

## Publication

Phase 1 performs no external writes. Phase 2 may update lifecycle labels and one machine-managed status comment after that write path is enabled. Phase 3 may publish a draft pull request. External bodies begin with `(AI Generated).` and a blank line. Automatic merge, release, deployment, issue closure, provider traffic, signing, secrets, and production migrations remain prohibited.
