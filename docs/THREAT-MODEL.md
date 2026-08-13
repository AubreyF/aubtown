# Threat model

## Protected assets

- repository source and unpublished work
- GitHub App credentials and installation scope
- Codex subscription credentials and quota
- Freed task, lease, event, and outcome integrity
- claim uniqueness and custody ownership
- provider and owner approval boundaries
- checkpoint confidentiality and integrity

## Trust boundaries

The coordinator, worker, GitHub App, Codex profile, repository authority system, checkpoint store, and each host are separate identities. A worker receives a scoped workspace and task prompt. It does not receive raw GitHub tracker credentials, checkpoint encryption roots, other subscriptions, or authority-state write access.

## Primary failures and controls

| Failure | Control |
| --- | --- |
| Duplicate dispatch after crash | Restate keyed claim, startup reconciliation, deterministic claim ID |
| Stale host publishes after transfer | Monotonic custody epoch checked before every write and publication |
| Label grants accidental authority | Exact active authority task and task-scoped repository execution claim are also required |
| Nightly runner and factory race | Proposed task-scoped claim must make the existing runner skip claimed work before the first writer is enabled |
| Quota telemetry disappears | No new admission and active turn interruption after 120 seconds |
| One account consumes the week in a day | Daily baseline thresholds plus 80 percent weekly ceiling |
| Codex update changes the worker or quota protocol | Absolute executable, exact version, generated-schema compatibility check, and advertised model and effort gate before host admission |
| Poll retry or host restart starts a second turn | One Restate command per host plus a mode-0600 local execution journal and app-server thread resume |
| Terminal result is accepted before work is recoverable | Host journal requires encrypted capture, edge-signed storage receipt, and catalog admission before the terminal executor receipt |
| Terminal result describes work other than the stored checkpoint | Receipt carries the content address; authenticated manifest must match current host, claim, epoch, exact command ID, and terminal stage |
| Validation or review is replayed against another change | Both receipts bind the complete checkpoint-backed work-product identity, including head and patch digest |
| Validation command changes uncommitted work while preserving Git HEAD | Custody archive digest is recomputed before and after each no-shell command and includes tracked plus approved-untracked state |
| Issue text injects a shell pipeline as validation | Repository adapter supplies reviewed argv recipes with absolute physical executables; issue prose is never executed |
| Implementation context approves its own work | Independent review requires a different thread and structured verdict; implementation-thread reuse is rejected |
| Reviewer changes the candidate while inspecting it | Review runs in a read-only, network-disabled app-server sandbox and publication rechecks the exact work-product identity |
| Restart skips validation or replaces a prior verdict | Checkpoint-keyed durable handoff registry enforces ordered immutable validation and review receipts |
| Returning stale host resumes work after failover | Signed startup reconciliation requires the exact current claim epoch, command, thread, turn, enrolled account, and quota headroom before app-server resume |
| Custody moves while the old host may still write | Per-host transfer fence cancels only unoffered commands and blocks offered, started, or ambiguous commands until terminal adjudication |
| Caller lies that a host is offline | Failover rereads canonical source and candidate heartbeats from ingress-private Restate state and requires at least 24 hours offline |
| Caller downgrades macOS-only work to Linux | Scheduler persists the qualified host lane with the claim and failover rejects any caller-supplied lane mismatch |
| Offline source command never reports interruption | Validated 24-hour failover marks it superseded before epoch transfer; startup adjudication quarantines the old turn when that host returns |
| Destination starts before unpublished work arrives | Every transferred epoch creates a durable restore requirement; executor poll and resume stay fenced until the destination's signed exact-state receipt is recorded |
| Initial worker starts in a guessed or stale directory | Every first-epoch claim creates a durable workspace requirement; poll and resume stay fenced until the selected host signs the exact clean branch and base commit |
| Restore is repeated after a crash | Destination first verifies the complete tracked and untracked worktree against the decrypted archive; exact restored state is accepted, while partial or divergent state fails closed |
| Scheduler chooses an arbitrary writable restore path | Host resolves the destination beneath its configured physical worktree root and invokes only the physical Freed helper inside the configured repository |
| Credential leaks into checkpoint | Denylisted paths, ignored-file exclusion, encryption, manifest review |
| Checkpoint manifest is changed | Manifest is authenticated as XChaCha20-Poly1305 associated data |
| Checkpoint restore overwrites destination work | Clean exact-base requirement and exclusive untracked-file creation |
| Provider-visible change runs unattended | Provider lane cap is zero and qualification is blocking |
| Repository adapter broadens authority | Adapter conformance tests and supported command allowlist |
| Dispatch input substitutes a host, account, branch, base, or task revision after authority | Short-lived admission digest binds the complete dispatch, then the workflow rechecks the canonical route before any Restate claim mutation |
| Tracker token reaches worker | Host-side GitHub App broker only |
| App token has unnecessary authority | One enrolled repository and operation-specific installation permissions |
| Malicious issue prompt changes policy | Issue text is data, fixed system policy remains outside worker input |
| Retry burns subscription quota | Retry budget distinguishes transient failure from authority and human blocks |
| Second queue appears | No ticket database or Markdown work queue in Freedworks |
| Restate storage is lost | Persistent volume, backups, claim reconciliation against external witnesses |
| Another process invokes an internal service directly | Every durable internal service is ingress-private, production omits the local integration harness, and Restate request identity authenticates runtime calls |
| Remote executor reaches scheduler ingress | Loopback-only Restate ports plus a narrow host edge with an exact route allowlist |
| Host message is forged or changed | Per-host Ed25519 signature over canonical identity, sequence, kind, time, and payload |
| Accepted host message is replayed | Restate idempotency plus a durable monotonic sequence checked before state mutation |
| Host key silently broadens authority | Enrollment fixes the host lane and allowed execution account IDs |
| Executor receives object-store credentials | Separate checkpoint edge owns storage and accepts only five-minute claim-bound grants |
| Stale host substitutes checkpoint content | Content address, schema 2 manifest identity, custody epoch, exact byte length, and host request proof must all match |
| Caller invents checkpoint metadata for failover | Storage edge signs the persisted reference, length, grant nonce, source host, and full manifest; Restate verifies current custody and catalogs the receipt before transfer |
| Compromised control plane invents a stored checkpoint | Receipt private key exists only at the checkpoint edge; the control plane receives only its public key |
| Pilot executor is compromised | Pilot checkpoint key can decrypt pilot archives, so only equally trusted executors receive it; external per-host key service is required before broadening trust |
| Grant is stolen or replayed | Grant binds one host and operation, requires that host's signature, and expires after five minutes; upload replay is idempotent and download remains encrypted |

## Fail-closed invariants

- One issue, one active claim, one current custody epoch.
- One claim, one branch, one worktree, one worker owner.
- No authority mutation through direct filesystem writes.
- No publication above the repository ceiling.
- No dispatch with stale GitHub, quota, host, authority, lease, pull request, or worktree evidence.
- No account selection without an enabled account and a compatible host.
- No execution at custody epoch two or later without the matching destination restore receipt.
- No execution at custody epoch one without the matching initial workspace receipt.
- No terminal executor result without its matching authenticated, cataloged command checkpoint.
- No publication with validation or review receipts for another work-product identity.
- No independent-review receipt from the implementation thread.
- No draft handoff before the checkpoint-keyed durable state reaches `ready`.
- No admitted dispatch workflow call from an unverified repository authority bridge.

## Deferred risks

The initial code does not provision GitHub Apps, cloud hosts, checkpoint encryption keys, or the Freed factory coordinator. Those operations require separate deployment receipts. The first real writer remains gated until Aubrey explicitly approves the task-scoped authority-claim correction and that extension is reviewed and installed.
