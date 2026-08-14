# Delivery phases

Status: Phase 1 is complete. Phase 2 is in progress around pinned Symphony, native services, and the approved task-scoped Freed authority extension.

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
- [x] Run the complete upstream Symphony suite against the pinned commit and patch, with 298 passing and 6 explicit skips.
- [ ] Prove a fake issue cannot dispatch twice across coordinator restart.
- [ ] Prove daily and rolling-week quota stops through the Symphony admission boundary.
- [ ] Prove Linux continues generic work while the Mac is offline.

## Phase 3: one Freed issue

- [x] Approve one factory coordinator plus task-scoped execution claims.
- [ ] Implement and review the Freed task-claim commands and coordinator actor.
- [ ] Install the native Linux authority broker.
- [ ] Execute one owner-selected low-risk runtime-neutral issue at concurrency one.
- [ ] Use Freed's supported authority commands and `scripts/worktree-add.sh`.
- [ ] Publish one draft pull request.
- [ ] Complete independent review, validation, projection, claim cleanup, and restart reconciliation.

## Phase 4: bounded parallelism

- [ ] Run two disjoint runtime-neutral workers.
- [ ] Route native work only to the Mac.
- [ ] Prove central subscription governance across both hosts.
- [ ] Complete a 72 hour soak without duplicate claims, cross-worktree writes, leaked credentials, or invalid publication.

## Phase 5: custody and remote operation

- [ ] Prove encrypted unpublished-work transfer between Mac and Linux.
- [ ] Transfer eligible custody after 24 hours offline and fence the stale epoch.
- [ ] Expose the dashboard through Tailscale only.
- [ ] Add selected phone alerts without adding a second dispatcher or queue.

Other repositories remain out of scope until the Freed pilot succeeds.
