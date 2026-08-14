# Architecture

## Governing rule

GitHub Issues are the only backlog and the complete operator-visible work view. Lifecycle labels and one machine-managed comment show every factory state and assigned executor. Immutable machine comments provide the canonical dispatcher election record. A repository authority adapter decides whether work may execute. Neither a dispatcher claim nor a GitHub lifecycle label can replace repository authority.

The coordinator polls open debt issues once per minute or responds to the equivalent webhook. Only an issue whose sole `factory:` lifecycle label is `factory:ready` can enter admission. Dispatch replaces that label with `factory:running`. The machine-managed comment shows the stage, host, worker, execution account alias, claim, custody epoch, branch, last heartbeat, draft pull request, blocker, summary, and next action. Ready issues show those unassigned fields explicitly. The coordinator never rewrites the human-authored issue description to record dispatch state.

Workers do not infer authority from that projection. They execute only a signed command bound to the winning GitHub claim and repository authority receipt. The issue body remains human-owned and never carries machine coordination state.

For Freed, dispatch requires all of these conditions:

1. The issue is open and labeled `debt` and `factory:ready`.
2. The issue is not labeled `automation-triage`.
3. Qualification contains one root cause, current evidence, bounded scope, acceptance criteria, exact validation, and conflict ownership.
4. A live Freed control task references the exact issue number and URL.
5. Once approved, the trusted factory coordinator grants a task-scoped execution claim through Freed's supported authority commands.
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

## Dispatcher election and recovery

Every coordinator uses the same GitHub App identity and a separately enrolled Ed25519 host identity. To compete for an eligible issue, a coordinator posts one immutable claim comment containing its host ID, public-key fingerprint, nonce, repository, issue, lease, and signature. The signed payload is hidden in the comment and the human-readable fields make the event auditable.

The first valid claim is the valid claim with the lowest GitHub comment ID. A coordinator waits through the 30 second collection window, rereads the issue comments, and computes that winner. It reads once more immediately before launching a worker and proceeds only if the same claim still wins. Missing, partial, or unavailable GitHub evidence stops dispatch. Invalid authors, unenrolled hosts, bad signatures, mismatched repositories or issues, and stale replayed payloads are ignored.

The winning claim is a short lease, not a permanent lock. The managed status comment carries its heartbeat and work-product projection. When the lease and heartbeat expire, another coordinator may publish a new claim round. It first reconciles the GitHub issue, repository authority, branch, draft pull request, checkpoint, and host journal. Ordinary process death therefore recovers automatically. Human reconciliation is reserved for ambiguous work products or policy gates, not every crash.

GitHub is the shared coordination ledger. A small host-local SQLite or atomic-file journal records process custody, subscription observations, and idempotency receipts so one host can resume without repeating expensive work. The journal is not a queue and cannot grant authority. AubTown v1 has no Restate server, database service, Docker container, or Compose runtime.

## Hosts

`linux-control-1` owns the durable runtime and generic Linux execution. `macos-executor-1` is an intermittent specialist for native macOS, Tauri, install, and soak work. Its absence does not stop portable work.

Each executor has one local Codex profile and one host identity. Credentials never move between hosts. Future subscription scaling assigns each subscription to an isolated executor profile. The route planner reads only enrolled hosts, GitHub-projected heartbeats, configured account-to-host assignments, and rolling-week usage observations. It excludes accounts not advertised by the current host heartbeat, fails closed when telemetry is missing, and selects the compatible account with the most weekly headroom. It never logs one process into a carousel of copied account files.

Linux is the preferred always-on coordinator and generic executor. A Mac is an intermittent specialist for native work and may also compete as a coordinator when Linux is unavailable. Each host signs claims, heartbeats, and quota observations with its own Ed25519 key. Enrollment fixes the corresponding public key, lane, and allowed account IDs. A host-local monotonic sequence and GitHub server timestamps reject replay before state changes.

Coordinators do not expose a general workflow ingress. Hosts communicate through GitHub for shared claims and projections, plus a narrow private checkpoint transfer edge when unpublished bytes must move. Tailscale carries that private transfer connection. The worker never receives GitHub App, subscription, checkpoint-root, or repository-authority credentials.

## Quota

The governor samples Codex app-server every 60 seconds and listens for rate-limit updates. It searches the primary, secondary, and multi-bucket views for the actual 10,080 minute window. It fails closed if app-server does not expose that rolling weekly window. It never assumes the field named `primary` is weekly.

- Autonomous weekly ceiling: 80 percent
- Reserved capacity: 20 percent
- Daily throttle: 7 percentage points
- Daily admission stop: 9 percentage points
- Daily interrupt: 10 percentage points
- Stale telemetry: interrupt after 120 seconds

The daily value is the increase from the Los Angeles day baseline within the same rolling window. A window reset begins a new baseline. Manual usage on the account reduces factory headroom. Earned reset credits are never consumed automatically. The coordinator replaces host observation time with its durable acceptance time, so clock skew between Linux and macOS cannot reorder one subscription's usage state.

Codex telemetry and interruption use the documented `account/rateLimits/read`, `account/usage/read`, and `turn/interrupt` app-server methods. The host agent submits the resulting observation through its signed gateway identity. See [Codex app-server](https://developers.openai.com/codex/app-server).

Before sending a heartbeat, each host resolves an absolute, non-group-writable Codex executable, checks the exact configured `codex --version` output, generates that binary's app-server JSON Schema bundle, and verifies every method and field AubTown consumes. It then calls `model/list` and requires an exact advertised model and reasoning effort. A binary update, protocol drift, unadvertised model, or unadvertised effort stops that executor before it can consume subscription capacity.

The stdio transport drains the app-server diagnostic stream, gives every request a bounded deadline, and terminates a child that does not stop cooperatively. App-server is bidirectional, so a numeric server-request ID must never be mistaken for a response to the client's request with the same ID. AubTown has no client-side approval or dynamic-tool surface. It rejects every server-initiated request explicitly and leaves the original client request pending for its real response. A timed-out request or unexpected child exit rejects active turn waiters, stops the host loop with a nonzero status, and leaves the execution journal intact for service-manager restart and signed reconciliation.

Executors poll through their signed `HostGateway` identity. A first-epoch claim creates a durable initial-workspace requirement bound to the admitted base commit, branch, host, worker, worktree, and conflict domains. The host invokes Freed's physical worktree helper inside the configured repository, verifies the physical destination, exact branch and commit, and clean Git state, then submits a signed receipt. Restate offers at most one nonterminal command per host only after that receipt and after rechecking the exact claim, custody epoch, enrolled account, host lane, deterministic prompt, conflict domains, command expiry, and fresh quota decision. The host journals command acceptance before `thread/start`, then journals the thread and turn before reporting start. On process replacement, the host first submits a signed reconciliation request for that exact command, claim epoch, account, thread, and turn. It calls `thread/resume` only when the coordinator confirms current custody, workspace or restore receipt, and quota headroom. Stale or superseded work stays quarantined. Workers may edit only qualified paths and may not commit. When a turn completes, the trusted host persists a private random finalization nonce, verifies the exact branch, base, owned paths, and dirty state, then creates one local commit carrying that nonce as an execution receipt. A crash retry accepts only that exact commit and receipt. The terminal checkpoint must name the finalized head. Completion is journaled before the signed result receipt is sent, so a failed network report is retried without repeating work. Every terminal receipt names the exact cataloged checkpoint for that command. The checkpoint manifest must authenticate the same host, claim, custody epoch, command ID, and terminal stage before Restate accepts the result.

The worker driver and usage source are separate interfaces. A future metered API driver can report a money or token budget through another usage source without changing claims, routing, custody, authority, or publication. The authority admission and immutable executor command bind the exact routed driver as well as the account. A host refuses both new and persisted commands for another configured driver. Multiple subscriptions remain isolated by host profile. Routing chooses an enabled host and account with measured headroom. Credentials never migrate with work.

## Repository adapters

The portable admission report is intentionally uniform across repositories. Each repository supplies a stricter authority adapter underneath it. Freed's adapter requires the exact canonical task, trusted launcher, worker lease, global behavior slot, provider gates, installed outcome, and soak contracts. A simpler future repository can implement a smaller authority control plane, but it cannot bypass the common issue, claim, quota, custody, conflict, and publication invariants.

The initial Freed bridge remains fail-closed until the authority extension in [FREED-AUTHORITY-BRIDGE.md](FREED-AUTHORITY-BRIDGE.md) is approved and implemented. It will not repurpose `nightly-writer`. Freed owns the task-claim command and receipt schemas. The private operations repository owns the scheduler and host broker implementation.

## Custody

Every terminal worker turn creates an encrypted checkpoint before the host may report completion, interruption, or failure. Capture, remote storage, and catalog admission are separate durable journal stages, so a retry does not rerun the worker or repeat an already persisted stage. The terminal result carries that checkpoint's content address. Restate resolves it through the authenticated catalog and requires `executor-command:<command ID>` plus the exact `worker-turn:<terminal stage>` in the manifest. Checkpoints include Git state, approved untracked files, validation receipts, and custody metadata. They exclude credentials, ignored files, dependencies, arbitrary untracked files, and authentication caches. On planned shutdown, the host interrupts an active turn and refuses to close app-server until the same checkpoint and terminal-report path drains successfully.

The pilot checkpoint implementation uses XChaCha20-Poly1305 with the manifest as authenticated associated data. A content-addressed atomic store retains encrypted archives. Restore requires a clean destination at the exact base head and advances custody before execution resumes. See [CHECKPOINT-CUSTODY.md](CHECKPOINT-CUSTODY.md).

An offline host triggers alerts at 1 hour and 12 hours. At 24 hours, portable work may transfer to an online compatible host. Before moving custody, the coordinator reads the exact claim, its scheduler-owned qualified host lane, and every candidate's canonical heartbeat from Restate. Caller-supplied online flags or lane claims do not grant failover authority. A planned transfer cancels only a pending command and blocks work already offered or started. A 24-hour offline transfer explicitly supersedes the old command after checkpoint validation, fences new source-host commands, advances the custody epoch, and creates a durable destination restore requirement. The destination creates its worktree with Freed's helper at the checkpoint's exact base head, downloads under its own claim-bound grant, decrypts and applies the archive, verifies the complete tracked and untracked state, and submits a signed restore receipt. Executor polling and startup reconciliation refuse every transferred claim until that exact receipt is durable. A returning stale host cannot call `thread/resume` because startup reconciliation sees the superseded command or old epoch and quarantines it.

Remote transfer uses two separate edges. The host edge mints a five-minute, claim-bound capability only after reading current Restate custody. The checkpoint edge owns the storage credential and consumes that capability plus an enrolled-host signature. After durable storage accepts the exact content-addressed bytes, the checkpoint edge signs a storage receipt that binds the object reference, length, grant nonce, source host, and complete checkpoint manifest. The source submits that receipt through its signed host envelope. Restate verifies the independent edge signature and current custody before recording it in the ingress-private checkpoint catalog. The custody workflow accepts only the exact cataloged reference. Caller-supplied checkpoint metadata cannot authorize failover. Executors receive encrypted bytes, not bucket credentials. Linux persistent storage is the pilot backend, with a content-compatible S3 adapter for later provider migration.

## Publication

Phase 1 performs no external writes. Phase 2 may update lifecycle labels and one machine-managed status comment after that write path is enabled. Phase 3 may publish a draft pull request. External bodies begin with `(AI Generated).` and a blank line. Automatic merge, release, deployment, issue closure, provider traffic, signing, secrets, and production migrations remain prohibited.

The terminal checkpoint becomes the portable work-product identity. It binds the repository, issue, claim, custody epoch, host, branch, worktree, command, content address, immutable admitted base, trusted-finalizer Git head, full tracked state digest, and implementation thread. The identity can be derived only when the completed command, authenticated checkpoint, command base, and journaled finalized head match. Validation uses the immutable base SHA, never a mutable remote-tracking ref, plus reviewed no-shell argv recipes with absolute physical executables. Receipts bind argv vectors, working directories, exit codes, output digests, and durations to that identity. The custody state inspector recomputes the complete state digest before and after every command, so a validation tool cannot silently rewrite the candidate. A new Codex thread performs independent review with a read-only, network-disabled sandbox and a turn-level structured output schema. Reusing the implementation thread, returning malformed output, requesting changes, or reporting serious findings fails closed. The reviewer contract is driver-neutral, so a future API or harness can produce the same receipt.

The ingress-private `HandoffRegistry` is keyed by checkpoint content address. A signed successful terminal executor receipt must authenticate its checkpoint and automatically initializes one exact work product before the host receives completion acknowledgement. An ingress-private adjudication command registry stores one immutable reviewed plan per host. The plan binds the exact work product, qualification, account, reviewer driver, and no-shell validation argv. The signed host poll returns `validate` or `review` only while account quota, current claim custody, the exact durable handoff, and that plan all agree. Exact validation and independent-review receipts return through the same narrow signed host edge. The edge accepts them only from the work product's current custody host and records them against the existing checkpoint identity. The registry durably advances that immutable identity through `awaiting-validation`, `awaiting-review`, and `ready`, or terminates it as `blocked`. It accepts byte-equivalent retries only. A changed receipt or reordered stage is rejected, so a restart cannot lose the execution-to-adjudication boundary, skip validation, replace the reviewer verdict, or accidentally publish a different attempt.

Each executor also keeps a private atomic adjudication journal. Validation and review run in the background so quota sampling and heartbeats continue. Before starting either operation, the host records an explicit start boundary. A crash at that boundary is treated as ambiguous and requires reconciliation rather than repeating work. Once a validation receipt or fresh reviewer handle is durable, reporting and reviewer waiting may be retried without rerunning validation or starting another subscription turn. An active or failed adjudication claim remains in host heartbeats and prevents that host from accepting a different execution command.

Publication planning fails closed unless current custody, exact issue authority, quota headroom, matching work-product validation, fresh independent review, safe lane classification, title hygiene, branch identity, and the draft-only ceiling all agree. A new base, head, patch, checkpoint, claim epoch, or reviewer context invalidates the handoff. The plan binds its repository, exact work product, prior remote head, and existing draft number when applicable. The Draft Publisher token broker accepts only that repository-bound admitted plan and narrows its installation token to one enrolled repository.

The host-side publisher checks the complete local state before and after its write. It passes the installation token through a private temporary askpass helper, never a Git argument or remote URL. Branch creation and update use an exact `--force-with-lease`, then GitHub must report the planned head. The publisher creates a draft only, or updates the one observed draft. It reconciles an exact branch or pull request left by a crash, but refuses a changed remote head, a ready pull request, duplicate open pull requests, another base, or another body. An ingress-private publication registry keyed by checkpoint address stores one immutable plan and one exact receipt. GitHub remains the external witness, so a crash between push and registry update is reconciled without creating another pull request.

The pilot-readiness proof assembles these boundaries around a real temporary Git repository while replacing only the worker, remote checkpoint edge, token broker, branch transport, and GitHub API with deterministic fakes. One test carries the exact candidate through trusted-host finalization, encrypted checkpoint capture, terminal reporting, immutable-base validation, a fresh structured reviewer context, handoff admission, draft planning, and a durable publication receipt. This proves composition without consuming subscription capacity or writing to GitHub. It does not replace the restart, container-ingress, or real Freed pilot gates.

The app-server implementation follows the official [Codex app-server thread, sandbox, output schema, and item lifecycle contracts](https://learn.chatgpt.com/docs/app-server).
