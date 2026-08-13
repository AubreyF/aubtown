# Freed authority bridge proposal

Status: approval required before Freed implementation

## Current evidence

Freed's control state is portable across Darwin and Linux at the kernel-guard layer. The trusted general-actor installation is not. Its launcher, provisioner, binding path, and host attestation are implemented in Swift and currently reject non-Darwin provisioning. Canonical tasks and leases also live under one machine-local state root.

Adding `freed-factory-worker-1`, `freed-factory-worker-2`, and later more worker actors would therefore create fixed concurrency slots, new root-owned launcher bindings, new lease guards, and repeated host migrations. It would still leave Linux execution dependent on whichever machine owns the canonical state.

## Recommended correction

Use one trusted `freed-factory-coordinator` identity on the canonical authority host. Represent worker ownership as task-scoped execution claims in Freed's active authority manifest.

Each task claim contains:

- claim ID
- GitHub issue number and URL
- custody epoch
- executor host ID
- worker ID
- branch and worktree identity
- conflict-domain digest
- acquisition and expiry timestamps

The coordinator lease authorizes only short control-plane transactions. It does not represent one long-running code writer. Restate serializes repository scheduling and asks the Freed bridge to create, transfer, heartbeat, or release one task claim through supported commands. Workers never receive the coordinator lease token and cannot mutate task authority directly.

This makes concurrency honest:

- one coordinator can serialize brief authority mutations
- two workers can execute two disjoint claimed tasks concurrently
- one task cannot have two current custody epochs
- the existing global behavior-slot rule remains independent
- provider and owner gates remain task-specific
- scaling subscriptions does not require adding actor identities

## Host topology

The mature authority home is the always-on Linux control host. It owns Restate, the canonical Freed automation state root, and a root-owned factory authority broker. Linux and macOS executors call that broker over mutually authenticated private transport. The broker invokes a pinned Freed control runtime locally and returns scoped receipts, never raw authority credentials.

The macOS pilot may run the same coordinator locally first. Moving canonical authority to Linux is a deliberate owner-controlled cutover with an immutable source snapshot, quiescence proof, destination verification, and rollback receipt. Files are never synchronized bidirectionally between hosts.

## Linux broker

Implement the broker in Go in this private operations repository. Keep the accepted command and receipt schemas in Freed so the product repository owns its authority contract. The Linux installation uses a root-owned executable and configuration under `/etc/freedworks`, a dedicated service user, a Unix socket for the local coordinator, and mTLS for remote Mac executors.

The broker command allowlist is limited to:

- inspect an exact issue-linked task
- create or reconcile one task execution claim
- heartbeat or transfer the current custody epoch
- release the exact current claim
- record approved task transitions and outcome receipts

No generic file, shell, lease, or task-mutation endpoint is exposed.

## Rejected alternatives

### Fixed worker-specific actors

This works for a one-Mac demo, but every concurrency slot becomes a permanent authority identity and kernel-guard migration. It scales badly across hosts and subscriptions.

### Mac-only remote authority broker

This preserves current launchers but stops all new Freed dispatch when the Mac is off. It directly contradicts the Linux continuity requirement.

### Replicated authority files

Synchronizing `current-tasks.json`, leases, or control events between hosts violates the local inode, transaction, and kernel-guard assumptions. It can create split-brain authority and is prohibited.

## Approval question

Approve replacing the earlier worker-specific lease plan with one trusted factory coordinator plus task-scoped execution claims, with Linux as the eventual canonical authority home and the Mac as an executor.
