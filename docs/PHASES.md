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
- [x] Bound app-server requests and shutdown, drain diagnostics, and reject colliding server-initiated requests without corrupting pending client calls.
- [x] Propagate unexpected app-server exit through active turns and restart the host agent without discarding its durable execution journal.
- [x] Add signed claim-bound command polling, durable host execution journaling, app-server turn recovery, and idempotent result reporting.
- [x] Fence custody transfer against offered, running, and ambiguous executor commands.
- [x] Require signed coordinator adjudication before a restarted host resumes a persisted turn.
- [x] Supersede stale source turns only after canonical 24-hour offline evidence and checkpoint validation.
- [x] Bind failover routing to the scheduler-owned qualified host lane.
- [x] Require an edge-signed, current-custody storage receipt before a checkpoint can authorize failover.
- [x] Withhold terminal worker receipts until capture, remote storage, and catalog stages are durably recorded.
- [x] Bind each terminal worker receipt to the exact authenticated command checkpoint and terminal stage.
- [x] Drain active work through the terminal checkpoint path during planned host shutdown.
- [x] Fence transferred execution until the destination downloads, restores, verifies, and signs the exact prior-epoch checkpoint.
- [x] Fence first-epoch execution until the selected host prepares and signs the exact clean initial worktree.
- [x] Route Linux and macOS lanes from durable heartbeats, enrolled account profiles, and rolling-week quota headroom.
- [x] Bind the route-selected worker driver through authority admission, executor command, new execution, and restart recovery.
- [x] Atomically convert a verified, claim-bound authority admission into scheduler, claim, workspace, and executor records.
- [x] Bind validation and independent-review receipts to the complete authenticated work-product identity.
- [x] Materialize the exact checkpoint-backed work product durably as part of accepting a successful terminal executor receipt.
- [x] Accept validation and independent-review receipts only through the signed current-custody host edge and advance the durable handoff to ready.
- [x] Dispatch immutable, quota-gated adjudication plans through the signed host edge without executing issue prose.
- [x] Execute reviewed no-shell validation recipes and prove complete Git state is unchanged after every command.
- [x] Run structured independent review in a fresh read-only, network-disabled Codex thread.
- [x] Persist one immutable checkpoint-keyed validation and review handoff through Restate.
- [x] Finalize each completed candidate as one host-receipted local commit before checkpointing.
- [x] Push an exact reviewed head and create or update one draft through a repository-scoped host credential without exposing it to the worker.
- [x] Reconcile publication crash retries and persist one immutable checkpoint-keyed publication receipt.
- [x] Prove the assembled fake-external pilot path from worker execution through finalization, checkpointing, exact validation, fresh review, handoff, publication planning, and durable draft receipt.

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
