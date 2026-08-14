# Architecture

Status: approved target, implementation in progress

## Control flow

GitHub Issues are the only backlog. A single Linux Symphony coordinator polls the selected repository. AubTown supplies the policy that decides whether an issue may enter execution, which host can run it, and what the resulting worker may publish. Freed remains authoritative for task execution.

The normal path is:

1. Aubrey applies `factory:ready` to an open Freed debt issue.
2. AubTown reads the issue, parses its qualification evidence, and inspects current GitHub, Freed, quota, host, pull-request, worktree, and conflict state.
3. AubTown acquires the exact task-scoped execution claim through a supported Freed command.
4. The issue moves to `factory:running` and its one machine-managed status comment records the claim, host, branch, heartbeat, and next action.
5. The selected host prepares the issue worktree through Freed's supported helper. Symphony verifies that exact worktree and starts one Codex app-server session.
6. The worker plans, implements, validates, repairs its candidate when permitted, and hands the exact candidate to a fresh reviewer context.
7. The trusted host may push the reviewed exact head and create or update one draft pull request.
8. The issue moves to `factory:human-review` or `factory:blocked`. AubTown does not merge, release, deploy, close the issue, or claim that merge equals completion.

## State and authority

GitHub is the shared coordination ledger and complete operator-visible queue. Freed's active task manifest is the execution authority. Neither Symphony's memory nor AubTown's local files can grant execution.

AubTown keeps small host-local journals for idempotency, quota observations, candidate finalization, validation, review, publication, and checkpoint transfer. These files answer whether a host already performed an operation after a crash. They are not a queue and cannot create work. The Symphony boundary writes one append-only receipt for each exact Freed claim before it admits launch. Exclusive publication lets only one concurrent process admit that claim. A later reconciled claim receives a different receipt without deleting history.

One issue has one current claim, custody epoch, branch, worktree, and worker owner. A claim is released or transferred by an exact supported transaction. Heartbeat age is evidence for reconciliation, not an automatic authority expiry.

## Symphony boundary

Symphony owns tracker polling, bounded concurrency, retry timing, issue workspaces, Codex app-server execution, its JSON API, and its LiveView dashboard. AubTown does not reimplement those mechanisms.

Production executes one immutable Symphony commit and verifies its source checksum. A separate tracking job observes upstream `main`. An upstream update becomes a deployment candidate only after the upstream suite, AubTown compatibility tests, disposable GitHub exercise, and restart proof pass.

The reviewed patch now supplies:

- GitHub App token refresh without exposing raw credentials to workers
- capability-aware SSH host routing
- a fail-closed AubTown admission boundary before worker launch

That boundary begins with one protected host-side candidate. The candidate binds qualification, selected host, current rolling-week usage, daily baseline, intended Freed task and claim, custody epoch, account, driver, and base head. It is non-authoritative. If it exactly matches a protected envelope from the same dispatch, AubTown reuses that envelope. If it changed, AubTown must acquire the new exact claim through the reviewed Freed broker before publishing a replacement envelope. The final boundary recomputes quota at launch time and records the exact claim before returning an admission receipt. Missing, stale, mismatched, repeated, or malformed state denies launch.

The reconciler's native snapshot command accepts the qualified issue, matching Freed task, intended claim, active claims and lanes, enrolled host observations, account profiles, usage snapshots, exact base head, and target in one protected file. Its pure assembly boundary enforces pilot concurrency, ignores host heartbeats older than 120 seconds, selects the compatible account and host with current headroom, and rejects a stale intended claim when routing has changed. The same snapshot produces byte-identical candidate state. The command then atomically publishes the protected candidate.

A native one-shot collector now reads the owner-selected GitHub issue, exact default-branch head, every open pull request, matching Freed task, signed host journal, local refs, and every local worktree. It writes one atomic mode-0600 planning report every minute. A deterministic second stage writes either one proposed dispatch intention or explicit blockers. A ready intention binds the source digest, task revision, selected host and account, `fix/issue-<number>` branch, host-specific worktree, target, initial claim, and base head. It independently rechecks source coherence, conflict caps, quota, route, pilot policy, and branch, pull-request, worktree, and claim collisions. It does not grant authority. Source errors, an unmatched task, incomplete claim evidence, stale compatible hosts, blocked quota, incomplete qualification, or disagreement between GitHub and local `origin/dev` keep both stages blocked. The current Freed command can list tasks but cannot list task-scoped execution claims, so the report deliberately remains blocked instead of interpreting an empty claim array as proof that no claims exist.

Host agents deliver Ed25519-signed heartbeat and rolling-week quota envelopes to one native Linux observation gateway. The gateway binds to loopback, with private Mac access supplied by Tailscale forwarding. It verifies enrollment scope, signature, host identity, sequence, timestamp, and request idempotency identity before atomically updating one mode-restricted journal. The same signed sequence and digest returns its original receipt after restart. Stale or conflicting sequence reuse fails closed. The journal is operational observation state, not a queue and not execution authority.

The deployed host process is telemetry only. It runs one idle Codex app-server connection to read the authenticated account's rolling-week window, then sends signed quota and heartbeat observations. It does not poll for executor commands, create worktrees, start coding turns, validate candidates, or review work. Symphony remains the one scheduler and Codex runner. The richer driver-neutral executor modules remain library code for future harness portability, but no v1 service launches them.

The native AubTown candidate publisher accepts that candidate as one protected physical input file. It applies the same runtime-neutral binding policy used by the Freed bridge, checks route identity and current quota, and publishes a mode-restricted candidate. Prelaunch checks the candidate against the actual launch instant before touching authority. A stale candidate therefore cannot acquire a claim and fail only afterward.

The AubTown bridge caller constructs the exact canonical claim request, invokes one absolute reviewed broker without a shell or inherited credentials, verifies every returned identity, and retries one lost local response with the same operation ID. It publishes the envelope only after successful claim acquisition. If envelope publication fails, it requests release of that exact claim. The prelaunch hook resolves candidates through this bridge and reuses only byte-equivalent dispatch state. The Freed command and installed broker remain pending, so this code cannot yet grant live authority.

The remaining integration work is:

- connect the admission command to Freed's task-scoped claim operations
- supply the stable intention with complete Freed task-claim evidence
- stage and attest deterministic Freed worktrees through `scripts/worktree-add.sh`
- full startup reconciliation around upstream's memory-only blocked and retry maps so a blocked exact claim can be released and replaced automatically when no worker launched

These remain an auditable patch series against the pin. AubTown will not maintain a TypeScript replacement for Symphony during v1.

## Host topology

Linux owns the one active coordinator, canonical Freed authority state, GitHub App broker, quota ledger, reconciliation, and shared encrypted checkpoint storage. It also appears to Symphony as an SSH worker for generic development.

The Mac appears as a second SSH worker with the `macos` capability. It owns its local Codex authentication, native toolchain, worktrees, and installed-test state. Turning it off removes only macOS capacity. Generic Linux work continues.

Both hosts may execute simultaneously. They do not run competing schedulers. If standby coordinator promotion is added later, the earliest valid immutable GitHub claim comment wins after a propagation window and a final authoritative reread. That election is not used for routine v1 dispatch.

## Admission and conflict control

Pilot admission requires all of the following:

- open issue
- `debt` and `factory:ready`
- no `automation-triage`
- one root cause and current evidence
- bounded scope and explicit acceptance criteria
- exact validation instructions
- owned paths or logical conflict locks
- explicit host, work-lane, behavioral, owner-review, and release-risk classifications
- matching active Freed task
- fresh quota and host observations
- no conflicting claim, branch, pull request, worktree, or task state
- no provider, release, migration, signing, deployment, secret, owner-review, or other sensitive unattended requirement

The standard Freed debt form supplies root cause, evidence, scope, and completion criteria. A pilot-ready issue also carries an AubTown qualification appendix using level-three headings for `Validation`, `Owned paths`, `Logical locks`, `Host lane`, `Work lane`, `Requires owner review`, `Behavioral`, and `Release or migration risk`. Lists use ordinary Markdown bullets. Boolean values are exactly `true` or `false`. Unknown values are ignored and therefore fail qualification rather than being guessed.

Conflict domains include qualified path prefixes and logical locks such as behavior, schema, auth, sync, provider, release, and macOS. Initial concurrency is one. Concurrency rises to two only after the single-worker restart and quota proofs pass. Two runtime-neutral tasks may overlap only when both path and logical domains are disjoint.

## Subscription governance

Each execution account has its own usage identity and Codex app-server process. AubTown samples the rolling-week window and active turns at least once per minute. Missing or stale telemetry stops new dispatch.

The governor reserves 10 percent by default, enforces a hard daily ceiling, and compares current use with the permitted rolling-week trajectory. It throttles before the hard boundary and interrupts targeted active turns when continuing would consume the protected reserve. Authority and human blockers do not consume retry budget.

Prelaunch quota enforcement is implemented. Active-turn interruption in the Symphony runner is still a required patch before unattended operation. The telemetry monitor emits `active-run-interrupt-required` at the hard boundary, but it does not pretend it can interrupt a Symphony-owned turn. The pilot writer stays disabled until Symphony consumes that signal or performs the equivalent current-usage check inside its active run loop.

Future subscriptions and APIs use separate account records, credentials, quotas, and worker drivers. Queue, authority, conflict, custody, and publication contracts remain unchanged.

## Crash recovery and custody

At startup, AubTown reconciles open issues, lifecycle comments, Freed tasks and claims, Symphony workspaces, local journals, branches, draft pull requests, host heartbeats, and checkpoint receipts. A mismatch blocks the issue. It never guesses that an absent in-memory retry means work is unclaimed. An append-only prelaunch receipt blocks the same exact claim after restart. Reconciliation may release an unlaunched claim and acquire a new claim, which creates a new receipt without erasing the crash record.

Every unpublished terminal candidate can be captured as an encrypted, content-addressed Git state archive. At 24 hours offline, portable work may move to a compatible host after the old command is fenced, the custody epoch advances, and the destination verifies the exact restored state. Linux cannot satisfy a macOS-only validation requirement.

## Security and publication

GitHub credentials stay host-side. The Coordinator App receives issue and label permissions. The Draft Publisher App receives repository-scoped contents and pull-request permissions only for an admitted publication plan. Workers receive neither raw credential.

The publication ceiling is draft pull request. Automatic readying, merge, release, deployment, issue closure, signing, secrets, migrations, provider traffic, and installed-soak conclusions remain outside v1 authority.

The dashboard binds to loopback and is exposed only through a private network such as Tailscale. Production uses native systemd on Linux and native worker tools on macOS. No Docker daemon is required.
