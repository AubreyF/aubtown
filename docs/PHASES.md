# Delivery phases

Status: Phase 2 is complete. Phase 3 is in progress around the approved task-scoped Freed authority extension and one real runtime-neutral pilot issue.

## Phase 0: architecture and threat model

- [x] Record authority, host, quota, custody, concurrency, and publication boundaries.
- [x] Initialize AubTown as a private-ops Git repository with no embedded secrets or mutable state.
- [x] Keep worker, tracker, authority, storage, subscription, and hosting integrations replaceable.
- [x] Approve one Linux coordinator with Linux and intermittent macOS workers.
- [x] Remove Restate, Docker, Compose, and CAR from the v1 scheduling core.

## Phase 1: shadow qualification

- [x] Read Freed issues without mutation.
- [x] Emit deterministic qualification reports and priority scores.
- [x] Compare a representative current issue sample.
- [x] Keep `automation-triage` outside pilot admission.
- [x] Keep owner application of `factory:ready` as the pilot authority.

## Phase 2: Symphony dry run

- [x] Select upstream Symphony rather than maintaining a second scheduler.
- [x] Pin one reviewed production commit and checksum separately from upstream tracking.
- [x] Record current GitHub, Codex, workspace, SSH worker, API, and dashboard capabilities.
- [x] Remove the superseded Restate and container runtime.
- [x] Preserve host-local journals, encrypted checkpoints, exact-head publication, and quota policy as reusable AubTown components.
- [x] Prove receipt publication is serialized across completion, flush, and shutdown.
- [x] Add the reviewed Symphony patch for GitHub App token refresh and capability-aware SSH routing.
- [x] Add native mode-0600 Coordinator token refresh before startup and every 35 minutes.
- [x] Refresh compatible locked dependencies until the Hex audit has no current security advisories.
- [x] Add the reviewed Symphony prelaunch admission boundary.
- [x] Add the Freed-specific `WORKFLOW.md`, helper-only workspace preparation, and fail-closed workspace guards.
- [x] Run the complete upstream Symphony suite against the pinned commit and patch series, with 304 passing and 6 explicit skips.
- [x] Prove a fake issue cannot dispatch twice across coordinator restart.
- [x] Prove the 15 percent daily throttle, 20 percent admission stop, 25 percent active interruption, and 80 percent rolling-week stop through the Symphony admission boundary.
- [x] Preserve gross daily quota consumption across weekly-window resets and cross-check it against cumulative token activity.
- [x] Keep rolling-window reset-estimate drift from fabricating same-day quota consumption after app-server restart.
- [x] Prove Linux continues generic work while the Mac is offline.
- [x] Add exact active-turn quota interruption and hard transport cutoff to the pinned Symphony runner.

## Phase 3: one Freed issue

- [x] Approve one factory coordinator plus task-scoped execution claims.
- [x] Implement AubTown's native protected candidate publisher, exact broker caller, and prelaunch envelope handoff.
- [x] Give the trusted coordinator identity the canonical control-state access its pinned broker requires while keeping workers isolated from authority state.
- [x] Implement a native protected reconciler CLI for pilot conflict, host, account, route, quota, and claim state.
- [x] Implement a native signed host gateway with durable heartbeat, quota, replay, and restart state.
- [x] Deploy lightweight host telemetry without enabling a second execution scheduler.
- [x] Implement the native read-only GitHub, Freed task, host, quota, ref, pull-request, and worktree planning snapshot.
- [x] Keep historical Freed tasks readable when they predate factory metadata, while requiring the complete contract on the exact candidate task.
- [x] Permit the read-only planning service to open only Freed's advisory task and event lock files while keeping every authority ledger path read-only.
- [x] Derive one deterministic fail-closed dispatch intention with host-specific workspace custody.
- [x] Add a protected native pilot-readiness audit that proves runtime, pin, authority-broker, planning, and dispatch gates.
- [x] Add a disposable broker conformance gate for replay, restart, transfer fencing, release semantics, and completion-time freshness.
- [x] Isolate disposable and production actor bindings with a service-private read-only launcher mount.
- [x] Add complete broker-backed active-claim and work-lane reconciliation for conflict planning.
- [x] Add active-turn claim stages, heartbeats, and race-safe unlaunched-claim recovery before startup and every minute.
- [x] Permit supported Symphony preflight reads to open only Freed's task and event kernel locks, refresh planning after broker conformance, preserve executor ownership of workspace custody, keep the outer mutation deadline longer than the broker's complete bounded authority lifecycle with a reviewed 15-minute schema ceiling, preserve validated Freed error envelopes from either output stream, and never retry a deterministic structured denial.
- [x] Bind the broker's initial `requestedAt` to the reconciler's fresh `claimedAt` so delayed prelaunch remains valid and exactly replayable.
- [x] Prepare the exact claim-bound Freed worktree on the selected SSH executor before Symphony launches a worker.
- [x] Keep Symphony's 15-minute admission deadline longer than the broker's 13-minute outer mutation deadline, its three-minute control command, and the remote workspace lifecycle so a valid claim cannot be orphaned by a nested timeout.
- [x] Preserve the executor-owned mode-0750 workspace root required by the separately enrolled Draft Publisher account during repeatable native host installation.
- [x] Run Freed's worktree helper with the protected worker's pinned Node and a minimal fixed executable path.
- [x] Require fresh SSH executor readiness that matches the selected host, repository, workspace root, and admitted base head.
- [x] Enforce the root-owned pinned-host SSH policy before readiness probes and worktree creation.
- [x] Persist one protected content-addressed executor handoff and active-workspace pointer after exact worktree preparation.
- [x] Bind handoff custody to qualification, task revision, account, driver, owned paths, publication ceiling, and trusted finalization identity.
- [x] Require private handoff roots in both Linux and macOS executor configurations and readiness evidence.
- [x] Add a required Symphony completion hook that propagates failure instead of using best-effort `after_run` semantics.
- [x] Finalize only qualified paths into one trusted commit and persist one immutable completion receipt.
- [x] Fence an already-finalized workspace before another Codex turn can spend subscription capacity.
- [x] Reconcile trusted completion against current GitHub eligibility, Freed task authority, exact claim custody, and active implementation-turn evidence.
- [x] Run reviewed exact validation and a fresh read-only independent review on the custody host.
- [x] Recheck and actively monitor rolling-week quota during review, with targeted interruption at a hard boundary.
- [x] Persist immutable adjudication results, resume durable reviewer handles after restart, and fence an ambiguous reviewer start.
- [x] Keep draft publication credentials on the custody host and route only a non-secret admitted plan over pinned SSH.
- [x] Persist publication, projection, and exact claim-release stages as restart-safe immutable transactions.
- [x] Project blocked adjudication and release its exact running claim without publishing a draft.
- [x] Require fresh dedicated publisher-account readiness evidence in the pilot launch audit.
- [x] Refresh the planning snapshot after executor and publisher probes so the final readiness audit sees one coherent evidence set.
- [x] Restrict the publisher SSH identity to a root-owned two-operation forced-command gateway.
- [x] Build clean host-specific releases with locked production dependencies and tamper-evident installation manifests.
- [x] Render exact private GitHub App registrations with disabled webhooks, disabled user OAuth, and selected-repository installation handoff.
- [x] Review and merge the Freed task-claim commands from PR #1491.
- [x] Build the host-neutral `factory-coordinator` broker with pinned runtime verification and bounded lease cleanup.
- [x] Honor Freed's bounded 370-second trusted-launcher lifecycle while keeping ordinary control commands at 90 seconds.
- [x] Build an idempotent Linux host installer that verifies one immutable release and leaves every service disabled.
- [ ] Install the native Linux authority broker.
- [x] Add hard-boundary active-turn interruption to the Symphony runner.
- [ ] Execute one owner-selected low-risk runtime-neutral issue at concurrency one.
- [ ] Use Freed's supported authority commands and `scripts/worktree-add.sh`.
- [ ] Publish one draft pull request.
- [x] Connect ready adjudication to draft publication, lifecycle projection, and exact claim cleanup behind the disabled pilot gate.

## Phase 4: bounded parallelism

- [ ] Run two disjoint runtime-neutral workers.
- [ ] Route native work only to the Mac.
- [ ] Prove central subscription governance across both hosts.
- [ ] Complete a 72 hour soak without duplicate claims, cross-worktree writes, leaked credentials, or invalid publication.

## Phase 5: custody and remote operation

- [x] Derive an exact verified-checkpoint transfer and restore plan after 24 hours offline.
- [ ] Prove encrypted unpublished-work transfer between Mac and Linux.
- [ ] Transfer eligible custody after 24 hours offline and fence the stale epoch.
- [ ] Expose the dashboard through Tailscale only.
- [ ] Add selected phone alerts without adding a second dispatcher or queue.

Other repositories remain out of scope until the Freed pilot succeeds.
