# Delivery phases

Status: Phase 1 complete. Phase 2 control-plane proofs complete except external status projection. Real Freed execution remains gated on explicit approval and implementation of the coordinator plus task-scoped claim authority correction.

## Phase 0: architecture and threat model

- [x] Record the approved authority, host, quota, custody, concurrency, and publication boundaries.
- [x] Create a private-ops repository structure with no embedded credentials or mutable service state.
- [x] Keep worker, tracker, authority, storage, and hosting integrations replaceable.
- [x] Complete the executable domain contracts and threat model tests.

## Phase 1: shadow qualification

- [x] Read Freed issues without mutation.
- [x] Emit deterministic qualification reports and priority scores.
- [x] Recommend three low-risk pilot candidates for owner selection.
- [x] Compare results against a representative issue sample.

## Phase 2: durable dry run

- [x] Run Restate with a fake worker.
- [x] Prove restart reconciliation and duplicate-dispatch prevention.
- [x] Prove quota interruption, custody fencing, and conflict locking.
- [x] Encrypt, store, transfer, and restore unpublished checkpoint work.
- [x] Add a vendor-neutral S3-compatible shared checkpoint adapter with content-address and recoverable-retirement checks.
- [x] Gate remote checkpoint access through short-lived, claim-bound transfer grants and enrolled-host request proofs.
- [x] Prove durable host liveness and 24 hour automatic custody transfer.
- [x] Prove startup reconciliation against canonical task, issue, branch, and worktree state.
- [x] Enforce exact-head draft publication planning and scoped GitHub App token minting.
- [x] Implement approved-only lifecycle status projection, disabled by default until external write authorization.
- [x] Authenticate Linux and macOS host telemetry with per-host Ed25519 identities and durable replay fencing.
- [x] Keep general Restate ingress loopback-only and expose only the narrow signed host edge to remote executors.
- [x] Make every durable internal Restate service ingress-private and omit the local integration harness from production.
- [x] Prove tamper rejection, private internal services, replay rejection, and replay persistence across a full restart.
- [x] Prove Mac-to-Linux encrypted checkpoint transfer, persistent restart recovery, and post-release grant denial.
- [x] Pin each executor to an absolute Codex binary, exact version, generated app-server protocol, advertised model, and advertised reasoning effort.
- [x] Add signed claim-bound command polling, durable host execution journaling, app-server turn recovery, and idempotent result reporting.

## Phase 3: one Freed issue

- [ ] Obtain approval for the task-scoped authority-claim correction.
- [ ] Implement and verify the Freed factory coordinator and Linux broker contract.
- [ ] Execute one owner-selected runtime-neutral issue.
- [ ] Use Freed's supported authority commands and worktree helper.
- [ ] Publish one draft pull request.
- [ ] Complete independent review, validation, projection, and lease cleanup.

## Phase 4: bounded parallelism

- [ ] Run two disjoint runtime-neutral workers.
- [ ] Complete a 72 hour soak without duplicate claims or cross-worktree writes.
- [ ] Demonstrate central subscription governance across Linux and macOS.

Other repositories remain out of scope until the Freed pilot succeeds.
