# Freed authority bridge proposal

Status: approval required before Freed implementation

## Current evidence

Freed's control state is portable across Darwin and Linux at the kernel-guard layer. The generic authority-file protocol selects `lockf` on macOS and `flock` on Linux. The trusted general-actor installation is not portable yet. `scripts/automation-actors.mjs` currently rejects provisioning and host commands unless `process.platform` is `darwin`, and its trusted host is implemented in Swift. Canonical tasks and leases also live under one machine-local state root.

The current task schema has no execution-claim field, claim event, or claim command. It accepts task-specific JSON details, but `task transition --details-json` replaces the stored details object. Smuggling custody into that route could discard `details.githubIssue`, acceptance criteria, or other authority context. It would also confuse a task lifecycle transition with executor ownership. A dedicated claim transaction is required.

Actor identities and powers are closed checked-in maps. The existing nightly runner owns the global `nightly-writer` lease for at most 30 minutes and may transition merge-safe task states. Adding a factory coordinator requires an explicit checked-in actor policy, specification, launcher binding, validation parity, and event provenance. A caller cannot invent that actor or repurpose `nightly-writer`.

Adding `freed-factory-worker-1`, `freed-factory-worker-2`, and later more worker actors would therefore create fixed concurrency slots, new root-owned launcher bindings, new lease guards, and repeated host migrations. It would still leave Linux execution dependent on whichever machine owns the canonical state.

## Recommended correction

Use one trusted `freed-factory-coordinator` identity on the canonical authority host. Represent worker ownership as one top-level `executionClaim` on the matching task in Freed's active authority manifest. Do not store it under `details`.

Each task claim contains:

- claim ID
- GitHub issue number and URL
- custody epoch
- executor host ID
- worker ID
- branch and worktree identity
- conflict-domain digest
- acquired, heartbeat, and optional transfer timestamps
- publication ceiling
- qualified base commit and work-product checkpoint when available

The coordinator lease authorizes only short control-plane transactions. It does not represent one long-running code writer. Restate serializes repository scheduling and asks the Freed bridge to create, transfer, heartbeat, or release one task claim through supported commands. Workers never receive the coordinator lease token and cannot mutate task authority directly.

The claim remains authoritative until an exact release or transfer transaction. `heartbeatAt` is liveness evidence, not automatic expiry authority. A dead heartbeat must block new execution until the existing claim is checkpointed and reconciled. Automatically expiring a code-writing claim would invite two hosts to believe they own the same unpublished branch, which is split brain wearing a tasteful JSON hat.

This makes concurrency honest:

- one coordinator can serialize brief authority mutations
- two workers can execute two disjoint claimed tasks concurrently
- one task cannot have two current custody epochs
- the existing global behavior-slot rule remains independent
- provider and owner gates remain task-specific
- scaling subscriptions does not require adding actor identities

## Proposed Freed contract

Add these supported commands to `scripts/automation-control.mjs`:

- `task claim-acquire`
- `task claim-heartbeat`
- `task claim-transfer`
- `task claim-release`
- `task claim-show`

Every mutation takes the task ID, expected task revision, coordinator actor, canonical coordinator lease and token, operation ID, and exact claim payload. Acquire requires no current claim. Heartbeat requires byte-equivalent identity and custody epoch. Transfer requires the current claim, authenticated checkpoint reference, next host and worker, and exactly the next custody epoch. Release requires the exact current claim and terminal handoff or cancellation reason. Retries use the same operation ID and payload. A changed retry fails.

The task-manifest transaction and event append stay one recoverable operation under the existing task guard. New deterministic events are `task_execution_claim_acquired`, `task_execution_claim_heartbeat`, `task_execution_claim_transferred`, and `task_execution_claim_released`. Each event carries the task and manifest revisions, complete redacted claim identity, actor lease provenance, and operation ID. Tokens and credentials never enter the task, event, receipt, or Restate state.

The initial `freed-factory-coordinator` policy should be `pr-only`, provider `forbidden`, no task creation, no task-state destinations, and one new `canManageExecutionClaims` capability. This is deliberately weaker than `freed-nightly-runner`. Draft publication remains the separate GitHub App boundary already implemented in Freedworks.

The nightly runner must use the same claim primitive before it starts implementation. It should skip tasks claimed by the factory or another runner. The factory should skip a task claimed by the nightly runner. `nightly-writer` may continue serializing the legacy nightly loop, but it cannot be the factory's writer authority. The existing global behavior slot, provider checks, owner review, installed identity, outcome writer, and soak rules continue unchanged.

## Host topology

The mature authority home is the always-on Linux control host. It owns Restate, the canonical Freed automation state root, and a root-owned factory authority broker. Linux and macOS executors call that broker over mutually authenticated private transport. The broker invokes a pinned Freed control runtime locally and returns scoped receipts, never raw authority credentials.

The macOS pilot may run the same coordinator locally first. Moving canonical authority to Linux is a deliberate owner-controlled cutover with an immutable source snapshot, quiescence proof, destination verification, and rollback receipt. Files are never synchronized bidirectionally between hosts.

## Linux broker

Implement the broker in Go in this private operations repository. Keep the accepted command, signed-intent, and receipt schemas in Freed so the product repository owns its authority contract. The Linux installation uses a root-owned executable and configuration under `/etc/freedworks`, a dedicated service user, a Unix socket for the local coordinator, and mTLS for remote Mac executors. This is a new coordinator-specific Linux trust path. It does not pretend the current macOS-only general-actor launcher already works on Linux.

The broker command allowlist is limited to:

- inspect an exact issue-linked task
- create or reconcile one task execution claim
- heartbeat or transfer the current custody epoch
- release the exact current claim
- record approved task transitions and outcome receipts

No generic file, shell, lease, or task-mutation endpoint is exposed.

The broker must persist its operation ID and coordinator token before invoking Freed, retain both across response loss, and use Freed's recoverable lease and task transactions. An unknown live lease or pending transaction remains a hard stop. The broker does not delete or repair authority files.

## Rejected alternatives

### Fixed worker-specific actors

This works for a one-Mac demo, but every concurrency slot becomes a permanent authority identity and kernel-guard migration. It scales badly across hosts and subscriptions.

### Mac-only remote authority broker

This preserves current launchers but stops all new Freed dispatch when the Mac is off. It directly contradicts the Linux continuity requirement.

### Replicated authority files

Synchronizing `current-tasks.json`, leases, or control events between hosts violates the local inode, transaction, and kernel-guard assumptions. It can create split-brain authority and is prohibited.

## Approval question

Approve this exact authority change:

1. One checked-in `freed-factory-coordinator` actor, initially `pr-only`, provider-forbidden, unable to create or transition tasks, and authorized only for dedicated execution-claim mutations.
2. One top-level persistent `executionClaim` per task, with no automatic authority expiry. Heartbeat staleness triggers checkpoint reconciliation, not takeover.
3. The nightly runner and Freedworks both use the same task-claim primitive, while `nightly-writer` remains only the legacy runner's global loop lease.
4. Linux eventually owns the single canonical authority root through a new coordinator-specific root-owned Go broker and signed Freed contract. The Mac remains an executor.
5. The first pilot retains the draft-PR-only publication ceiling and does not relax provider, behavior-slot, owner-review, merge, release, install, or soak gates.

Implementation in Freed begins only after Aubrey explicitly approves all five points.
