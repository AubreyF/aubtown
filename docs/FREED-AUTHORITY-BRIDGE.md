# Freed authority bridge

Status: AubTown broker caller and envelope handoff implemented, Freed commands and actor pending

## Purpose

GitHub makes an issue schedulable. It does not grant permission to alter Freed. Every real dispatch also requires an active Freed task whose `details.githubIssue` exactly matches the issue number and URL.

The bridge translates one admitted AubTown dispatch into a short Freed control-plane transaction. It never edits `current-tasks.json`, lease files, or control events directly.

## Approved authority model

Freed gains one checked-in `freed-factory-coordinator` actor. This actor is initially:

- `pr-only`
- provider-forbidden
- unable to create tasks
- unable to transition task lifecycle state
- authorized only for dedicated execution-claim operations

The coordinator lease exists only while the broker performs a control-plane transaction. It is not a permanent worker lease and does not represent a long-running code writer.

Each active task may hold one top-level `executionClaim`. It is separate from `details` so a claim operation cannot erase issue identity, acceptance criteria, or other task context.

The claim records:

- claim ID
- GitHub issue number and URL
- custody epoch
- executor host and worker IDs
- branch and worktree identity
- qualified base commit
- conflict-domain digest
- execution account and driver IDs
- qualified target
- acquired and heartbeat times
- optional transfer time and checkpoint reference
- publication ceiling

Heartbeat staleness triggers reconciliation. It does not silently expire authority. Release or transfer requires an exact current-claim transaction.

## Supported Freed commands

Add these operations to `scripts/automation-control.mjs`:

- `task claim-acquire`
- `task claim-heartbeat`
- `task claim-transfer`
- `task claim-release`
- `task claim-show`

Every mutation includes the task ID, expected task revision, coordinator actor, canonical coordinator lease, operation ID, and exact claim identity. Acquire requires no existing claim. Heartbeat requires the same claim and epoch. Transfer requires an authenticated checkpoint, a compatible destination, and exactly the next epoch. Release requires the exact claim and an allowed terminal reason.

AubTown calls the root-owned broker with one no-shell command:

```text
/opt/freed/bin/factory-coordinator task claim-acquire --request-json <canonical-json>
/opt/freed/bin/factory-coordinator task claim-release --request-json <canonical-json>
```

The acquire request binds the operation ID, task and expected revision, complete AubTown binding digest, issue, claim and custody epoch, host, worker, branch, worktree, conflict domains and digest, base head, account, driver, target, draft-only ceiling, and request time. Release binds the original admission, operation ID, exact claim, binding digest, reason, and release time. The JSON contains no credential or lease token. The broker supplies its pinned state root, actor, and short-lived coordinator lease internally.

Retries with the same operation ID and byte-equivalent payload are idempotent. AubTown performs one exact local retry after command failure using the same argv and operation ID. A changed retry or mismatched broker response fails.

The task transaction and event append remain one recoverable Freed operation. New events are:

- `task_execution_claim_acquired`
- `task_execution_claim_heartbeat`
- `task_execution_claim_transferred`
- `task_execution_claim_released`

Tokens and private credentials never enter task, event, GitHub, Symphony, or checkpoint state.

## Bridge preflight

Immediately before Symphony launches a worker, the bridge must:

1. Re-read the GitHub issue and lifecycle projection.
2. Re-read the exact active Freed task.
3. Verify issue number, URL, task revision, task state, provider authority, behavior flag, and execution ceiling.
4. Check quota, host capability, branch, worktree, pull-request, and conflict state.
5. Publish one protected non-authoritative candidate that binds the exact dispatch state.
6. Reuse an existing envelope only when it exactly matches that candidate. Otherwise acquire or reconcile the candidate's exact task claim through the supported command.
7. Return a redacted receipt that binds task revision, claim ID, custody epoch, host, worker, base commit, conflict digest, and expiry of the admission decision.
8. Publish one protected per-issue admission envelope, then let the final Symphony boundary recompute quota and atomically record the exact claim before returning success.

Symphony may start work only when the receipt still matches a final prelaunch reread. A receipt is not transferable to another issue, host, branch, account, driver, or base commit.

## Nightly runner coexistence

The existing nightly runner must use the same task-claim primitive before implementation. It skips a task claimed by AubTown or another runner. AubTown skips a task with a different current claim.

The existing `nightly-writer` lease may continue to serialize the legacy nightly loop. AubTown does not acquire or overload it. The global behavioral slot, provider gates, owner review, installed identity, outcome evidence, and soak contracts remain independent.

## Linux authority broker

Linux eventually owns the one canonical Freed authority state root. A root-owned coordinator broker invokes a pinned Freed control runtime locally and returns narrowly scoped receipts. Workers never receive its lease or filesystem access.

The broker allowlist is limited to:

- inspect an exact issue-linked task
- acquire or reconcile one execution claim
- heartbeat the current epoch
- transfer one checkpoint-backed custody epoch
- release the exact current claim
- record separately approved outcomes

It exposes no generic shell, file, lease, or task-mutation endpoint. The Mac is an executor and keeps no replica of canonical authority files.

## Current implementation gate

`FreedAuthorityBridge.inspect`, the broker caller, exact response validation, response-loss retry, exact release, protected candidate loading, exact envelope reuse, protected envelope publication, and publication-failure release are implemented and tested in AubTown. The adapter remains fail-closed when the reviewed broker path is absent for a changed candidate. Freed still needs the matching commands, transaction schema, events, coordinator actor, installed Linux broker, and production candidate producer. No real AubTown writer may be enabled before both sides pass integration tests.
