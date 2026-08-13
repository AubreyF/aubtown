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
| Label grants accidental authority | Exact active authority task and short-lived repository lease are also required |
| Nightly runner and factory race | Proposed task-scoped claim must make the existing runner skip claimed work before the first writer is enabled |
| Quota telemetry disappears | No new admission and active turn interruption after 120 seconds |
| One account consumes the week in a day | Daily baseline thresholds plus 80 percent weekly ceiling |
| Codex update changes the worker or quota protocol | Absolute executable, exact version, generated-schema compatibility check, and advertised model and effort gate before host admission |
| Poll retry or host restart starts a second turn | One Restate command per host plus a mode-0600 local execution journal and app-server thread resume |
| Custody moves while the old host may still write | Per-host transfer fence cancels only unoffered commands and blocks offered, started, or ambiguous commands until terminal adjudication |
| Credential leaks into checkpoint | Denylisted paths, ignored-file exclusion, encryption, manifest review |
| Checkpoint manifest is changed | Manifest is authenticated as XChaCha20-Poly1305 associated data |
| Checkpoint restore overwrites destination work | Clean exact-base requirement and exclusive untracked-file creation |
| Provider-visible change runs unattended | Provider lane cap is zero and qualification is blocking |
| Repository adapter broadens authority | Adapter conformance tests and supported command allowlist |
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
| Grant is stolen or replayed | Grant binds one host and operation, requires that host's signature, and expires after five minutes; upload replay is idempotent and download remains encrypted |

## Fail-closed invariants

- One issue, one active claim, one current custody epoch.
- One claim, one branch, one worktree, one worker owner.
- No authority mutation through direct filesystem writes.
- No publication above the repository ceiling.
- No dispatch with stale GitHub, quota, host, authority, lease, pull request, or worktree evidence.
- No account selection without an enabled account and a compatible host.

## Deferred risks

The initial code does not provision GitHub Apps, cloud hosts, checkpoint encryption keys, or the Freed factory coordinator. Those operations require separate deployment receipts. The first real writer remains gated until Aubrey explicitly approves the task-scoped authority-claim correction and that extension is reviewed and installed.
