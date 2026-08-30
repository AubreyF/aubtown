# Freed authority bridge

Status: Freed commands published for review; AubTown broker binary implemented but not installed

## Purpose

GitHub makes an issue schedulable. It does not grant permission to alter Freed. Every real dispatch also requires an active Freed task whose `details.githubIssue` exactly matches the issue number and URL.

The bridge translates one admitted AubTown dispatch into a short Freed control-plane transaction. It never edits `current-tasks.json`, lease files, or control events directly.

## Approved authority model

The initial pilot reuses Freed's reviewed `freed-nightly-runner` actor and
`nightly-writer` trusted-launcher lease. AubTown does not create another actor
or give workers that lease. The host broker acquires it for one claim mutation,
passes the token only to Freed's pinned control command, releases it with an
exact retry identity, and exits.

Active claims and the latest operation receipt for each task are top-level
projections in Freed's existing `current-tasks.json`. They do not enter task
`details`, alter the task revision, or create another authority file.

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
- qualified work lane
- acquired and heartbeat times
- execution stage, `claimed` or `running`
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
- `task claim-list`

Every mutation includes the task ID, expected task revision, coordinator actor, canonical coordinator lease, operation ID, and exact claim identity. Acquire requires no existing claim. Heartbeat requires the same claim and epoch. Transfer requires an authenticated checkpoint, a compatible destination, and exactly the next epoch. Release requires the exact claim, custody epoch, last observed heartbeat, and an allowed terminal reason. A heartbeat racing a release makes the release fail instead of terminating live custody.

`claim-show` returns either the exact current claim and binding digest or an explicit null claim. `claim-list` returns every active task claim with task revision, binding digest, custody, conflict domains, and work lane. Planning uses that complete list for global and per-lane concurrency. Both operations are read-only. Neither infers an empty claim set from missing state.

AubTown calls the root-owned broker with one no-shell command:

```text
/opt/freed/bin/factory-coordinator task claim-acquire --request-json <canonical-json>
/opt/freed/bin/factory-coordinator task claim-release --request-json <canonical-json>
```

The acquire request binds the operation ID, task and expected revision, complete AubTown binding digest, issue, claim and custody epoch, host, worker, branch, worktree, conflict domains and digest, base head, account, driver, target, draft-only ceiling, and request time. The request time is the reconciler's fresh `claimedAt` value, not the later wall-clock instant when Symphony reaches prelaunch. Freed requires those fields to match for replay-safe initial claims. Release binds the original admission, operation ID, exact claim, binding digest, reason, and release time. The JSON contains no credential or lease token. The broker supplies its pinned state root, actor, and short-lived coordinator lease internally.

Retries with the same operation ID and byte-equivalent payload are idempotent. AubTown performs one exact local retry after an uncertain command failure using the same argv and operation ID. A machine-readable Freed denial is final and is never retried. A changed retry or mismatched broker response fails.

Expected denials are machine-readable JSON errors on standard error. The conformance gate requires `operation_replay_conflict`, `claim_already_exists`, and `claim_epoch_mismatch` at the relevant boundaries. A crash, timeout, plain-text failure, or another error code does not count as successful fencing.

## Disposable broker conformance

The installed broker must pass `npm run freed:broker-conformance -- <absolute-input-file>` before pilot readiness can pass. The protected input may name only a profile beginning with `conformance-`. That profile must use disposable task and authority state. It must never point at Freed's canonical production state root.

Start from `config/repositories/freed-broker-conformance.example.json`. The runner generates fresh operation IDs and strictly ordered lifecycle timestamps on each invocation. The checked-in fixture contains no credential and grants no authority. The installed broker profile is responsible for mapping `conformance-freed-pilot` to isolated disposable state.

On Linux, the conformance actor launchers live in the protected `/etc/freed/automation-actor-launchers-conformance` tree. The conformance service uses a private read-only bind mount to present that tree at Freed's standard launcher path inside only its mount namespace. The production launcher tree is never replaced, and every other process continues to see the canonical production bindings.

The conformance command starts a new broker process for every operation and proves:

- exact acquire and response-loss replay
- rejection of a changed request under the same operation ID
- one durable projected claim after restart
- rejection of a second acquire
- exact heartbeat and replay
- rejection of a changed heartbeat replay
- checkpoint-backed transfer by exactly one custody epoch
- fencing of the prior epoch
- permanent fencing of an older operation ID after custody advances
- exact destination custody after restart
- complete active-claim listing after acquire and transfer
- exact release and response-loss replay
- absence of dispatchable claim state after release and restart
- absence of the released claim from the active-claim list

The report binds the physical broker path and SHA-256 digest. `aubtown-pilot-readiness.service` requires a passing report no older than 10 minutes for the same executable. A self-reported success, a report for another binary, a stale report, or a missing named check blocks launch.

The task transaction and event append remain one recoverable Freed operation. New events are:

- `task_claim_acquire`
- `task_claim_heartbeat`
- `task_claim_transfer`
- `task_claim_release`

Claims begin at `claimed`. Once Symphony has a live thread and turn, its 30 second active guard moves the claim to `running` and sends an exact heartbeat. Missing or conflicting heartbeat authority interrupts the turn. A native reconciliation timer releases only stale `claimed` records after 120 seconds without a heartbeat and a five-minute initial launch grace. The same reconciler runs before Symphony starts. A stale `running` record remains authoritative custody for workspace recovery or the 24-hour checkpoint transfer path. Heartbeat age never silently discards unpublished work.

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

The existing nightly runner and AubTown share the same coordinator identity and
task-claim primitive. The short-lived `nightly-writer` lease serializes only
control-plane transactions. Task-scoped claims carry concurrent worker custody.
The global behavioral slot, provider gates, owner review, installed identity,
outcome evidence, and soak contracts remain independent.

## Linux authority broker

Linux eventually owns the one canonical Freed authority state root. The
root-owned `factory-coordinator` binary invokes a checksum-pinned Freed control
runtime locally and returns narrowly scoped receipts. On Linux it reads
root-owned profiles from `/etc/aubtown/freed-broker-profiles`. The initial Mac
profile lives under `/Library/Application Support/AubTown/freed-broker-profiles`.
Workers never receive the coordinator lease or filesystem access.

The broker allowlist is limited to:

- inspect an exact issue-linked task
- acquire or reconcile one execution claim
- heartbeat the current epoch
- transfer one checkpoint-backed custody epoch
- release the exact current claim
- record separately approved outcomes

It exposes no generic shell, file, lease, or task-mutation endpoint. The Mac is an executor and keeps no replica of canonical authority files.

The trusted actor launcher has a bounded lifecycle of up to 370 seconds. The
broker gives that launcher a 380-second caller deadline so it can finish its
own challenge, acquisition, and cleanup contract. Ordinary Freed task and
lease control commands retain a separate 90-second deadline. A slow trusted
acquisition therefore cannot silently widen every child-process boundary, and
the broker does not kill a healthy launcher before its reviewed lifecycle
expires.

AubTown gives each complete mutating broker invocation a 12-minute outer
deadline. That covers the broker's bounded worst case of trusted acquisition,
one task mutation, and two exact lease-release attempts without killing the
broker while its protected child is still cleaning up. Read-only claim
operations retain a two-minute outer deadline. An explicitly configured test
deadline may override both, but production uses the operation-specific bounds.

## Current implementation gate

`FreedAuthorityBridge.inspect`, the protected reconciler and candidate
publisher, shared exact broker client, complete claim listing, disposable
lifecycle conformance, exact response validation, response-loss retry, exact
release, prelaunch freshness, envelope publication, live planning collector,
and deterministic dispatch intention are implemented and tested in AubTown.
Merged Freed PR #1491 supplies the matching claim commands, transaction
projection, recovery, and event history. AubTown now builds the cross-platform
`factory-coordinator` binary, which pins every Freed runtime file by checksum,
scrubs child environments, keeps lease tokens out of arguments and output, and
releases the coordinator lease after success or rejection. Review, installation,
disposable conformance against the real Freed commands, and the owner-selected
pilot remain pending. No real writer may be enabled before those gates pass.
