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

AubTown keeps small host-local journals for idempotency, quota observations, candidate finalization, validation, review, publication, and checkpoint transfer. These files answer whether a host already performed an operation after a crash. They are not a queue and cannot create work. The Symphony boundary writes one append-only receipt for each exact Freed claim before it admits launch. Exclusive publication lets only one concurrent process admit that claim. A later reconciled claim receives a different receipt without deleting history. Each executor also keeps immutable content-addressed handoff manifests and one atomic pointer per workspace. The pointer identifies which exact claim currently owns that workspace. It cannot create a claim or replace a Freed authority receipt.

One issue has one current claim, custody epoch, branch, worktree, and worker owner. A claim is released or transferred by an exact supported transaction. Heartbeat age is evidence for reconciliation, not an automatic authority expiry.

## Symphony boundary

Symphony owns tracker polling, bounded concurrency, retry timing, issue workspaces, Codex app-server execution, its JSON API, and its LiveView dashboard. AubTown does not reimplement those mechanisms.

Production executes one immutable Symphony commit and verifies its source checksum. A separate tracking job observes upstream `main`. An upstream update becomes a deployment candidate only after the upstream suite, AubTown compatibility tests, disposable GitHub exercise, and restart proof pass.

The reviewed patch now supplies:

- GitHub App token refresh without exposing raw credentials to workers
- capability-aware SSH host routing
- a fail-closed AubTown admission boundary before worker launch
- a fail-closed active-run guard inside the Codex app-server turn loop

That boundary begins with one protected host-side candidate. The candidate binds qualification, selected host, current rolling-week usage, daily baseline, intended Freed task and claim, custody epoch, account, driver, and base head. It is non-authoritative. If it exactly matches a protected envelope from the same dispatch, AubTown reuses that envelope. If it changed, AubTown must acquire the new exact claim through the reviewed Freed broker before publishing a replacement envelope. The final boundary recomputes quota at launch time and records the exact claim before returning an admission receipt. Missing, stale, mismatched, repeated, or malformed state denies launch.

The reconciler's native snapshot command accepts the qualified issue, matching Freed task, intended claim, active claims and lanes, enrolled host observations, account profiles, usage snapshots, exact base head, and target in one protected file. Its pure assembly boundary enforces pilot concurrency, ignores host heartbeats older than 120 seconds, selects the compatible account and host with current headroom, and rejects a stale intended claim when routing has changed. The same snapshot produces byte-identical candidate state. The command then atomically publishes the protected candidate.

A native one-shot collector now reads the owner-selected GitHub issue, exact default-branch head, every open pull request, matching Freed task, every active broker claim and work lane, signed host journal, local refs, and every local worktree. It writes one atomic mode-0600 planning report every minute. A deterministic second stage writes either one proposed dispatch intention or explicit blockers. A ready intention binds the source digest, task revision, selected host and account, `fix/issue-<number>` branch, host-specific worktree, target, initial claim, and base head. It independently rechecks source coherence, conflict caps, quota, route, pilot policy, and branch, pull-request, worktree, and claim collisions. It does not grant authority. Source errors, an unmatched task, incomplete claim evidence, stale compatible hosts, blocked quota, incomplete qualification, or disagreement between GitHub and local `origin/dev` keep both stages blocked. Freed draft PR #1491 and AubTown's one-shot broker now provide the source contract, but live reports remain blocked until the reviewed commands and broker are installed and pass disposable conformance.

Host agents deliver Ed25519-signed heartbeat and rolling-week quota envelopes to one native Linux observation gateway. The gateway binds to loopback, with private Mac access supplied by Tailscale forwarding. It verifies enrollment scope, signature, host identity, sequence, timestamp, and request idempotency identity before atomically updating one mode-restricted journal. The same signed sequence and digest returns its original receipt after restart. Stale or conflicting sequence reuse fails closed. The journal is operational observation state, not a queue and not execution authority.

The deployed host process is telemetry only. It runs one idle Codex app-server connection to read the authenticated account's rolling-week window, then sends signed quota and heartbeat observations. It does not poll for executor commands, create worktrees, start coding turns, validate candidates, or review work. Symphony remains the one scheduler and Codex runner. The richer driver-neutral executor modules remain library code for future runner portability, but no v1 service launches them.

The native AubTown candidate publisher accepts that candidate as one protected physical input file. It applies the same runtime-neutral binding policy used by the Freed bridge, checks route identity and current quota, and publishes a mode-restricted candidate. Prelaunch checks the candidate against the actual launch instant before touching authority. A stale candidate therefore cannot acquire a claim and fail only afterward.

The AubTown bridge caller constructs the exact canonical claim request, invokes one absolute reviewed broker without a shell or inherited credentials, verifies every returned identity, and retries one lost local response with the same operation ID. Before readiness can pass, AubTown expands and checks the selected OpenSSH alias. The root-owned config must use the dedicated executor user, one identity, one private known-hosts file, strict host-key checking, a host-key alias equal to the AubTown host ID, bounded timeouts, public-key authentication, and no password fallback, agent forwarding, port forwarding, or connection multiplexing. AubTown records the config and SSH executable digests in the protected executor report. It then probes the selected executor through that alias. The probe verifies the physical Freed checkout, writable workspace root, private handoff root, exact remote base ref, pinned Node and Git runtimes, physical worktree helper, and immutable workspace-preparer file. The protected result must be fresh and match the selected dispatch.

After claim acquisition, the prelaunch hook rechecks the SSH policy and sends one base64url-encoded, schema-checked workspace requirement through the same alias to the fixed remote preparer. That command verifies the enrolled host and Freed repository, then invokes the physical `scripts/worktree-add.sh`. After the worktree passes exact branch, base-head, and cleanliness checks, the preparer writes an immutable manifest under the executor's private handoff root. The manifest binds the repository, issue, claim, custody epoch, host, worker, branch, worktree, conflict domains, qualification, authority task revision, account, driver, owned paths, draft-only publication ceiling, and deterministic trusted-finalizer nonce. A separate atomic pointer maps the physical workspace to that manifest. The request timestamp is excluded from the manifest, so an exact retry resolves to the same content digest.

The handoff root is outside the worker workspace and mode 0700. Its files are mode 0600. The Codex workspace-write sandbox cannot modify them. They contain no GitHub, Codex, checkpoint, or Freed credential. A later trusted completion hook can find exact custody from its current working directory without receiving issue prose or a mutable command line. AubTown publishes the authority envelope only after the preparer writes this state and returns a matching receipt. If workspace preparation, handoff publication, or envelope publication fails, it requests release of the exact claim. The prelaunch hook reuses only byte-equivalent dispatch state. Review, installation, and real disposable conformance remain pending, so this code cannot yet grant live authority.

The third Symphony patch adds `hooks.completion` as a required success boundary. Symphony invokes it after all configured Codex turns succeed and before best-effort `after_run` cleanup. Failure or timeout propagates to the orchestrator. The AubTown completion command runs on the selected executor. It reloads the active-workspace pointer, verifies the content digest and exact runtime custody, rejects symbolic or substituted paths, and checks the enrolled repository and branch. It then stages only paths covered by the qualification report and creates one commit carrying the deterministic finalization receipt. An immutable completion receipt binds that head to the manifest, claim, task, account, and driver.

Completion is idempotent. Repeating the hook verifies the existing exact commit and returns the first receipt. If Symphony retries the open issue, the `before_run` guard sees the receipt and fails before starting Codex. The hook has no GitHub or Freed credential and cannot publish.

The coordinator completion timer reads the exact receipt through the enrolled SSH alias. Before it spends another reviewer turn, it rechecks the open `factory:ready` issue, current Freed task revision, exact broker claim and heartbeat, current quota, and the active implementation thread and turn. It rejects substituted custody, stale authority, or a completion that does not match the admitted handoff. The resulting adjudication command is content-addressed by the completion receipt, so a coordinator restart resolves to the same command.

The custody host runs only validation commands from a protected reviewed repository profile. It checks the clean branch head and binary patch digest before and after every command. A separate Codex app-server process uses a reviewer-specific `CODEX_HOME`, verifies that the configured model is currently callable, and runs one read-only structured review in a thread different from implementation. Quota is reread before review and sampled while the turn runs. A hard daily or rolling-week decision interrupts that exact review turn. The host stores a durable reviewer handle and immutable result. A restart resumes the stored handle. A crash between remote review start and handle persistence is fenced as ambiguous rather than silently starting another paid turn.

The coordinator stores the returned trusted adjudication result under its protected admission state. A passing result still grants no publication authority. Draft publication must reread GitHub, Freed authority, claim custody, and quota again, then bind the exact validation and review receipts to the existing draft-only publisher.

Before pilot readiness trusts that broker, a disposable conformance gate starts a fresh process for every claim operation. It proves durable exact replay, structured conflict rejection, one current claim, checkpoint-backed epoch transfer, stale-epoch fencing, and exact release. The protected result binds the installed executable digest and expires after 10 minutes. This is a launch test, not another scheduler, queue, database, or resident service.

The native pilot audit is the final read-only proof before launch. It binds the installed Symphony commit and patch digests, reviewed workflow, compiled policy hooks, Freed broker, fresh planning snapshot, ready dispatch, repository, issue, task, and intended claim into one protected report. It does not grant authority. A missing broker, stale snapshot, blocked dispatch, changed patch, unsafe mode, or identity substitution produces a named blocker and a nonzero exit.

The remaining integration work is:

- install and prove the reviewed Freed task-claim operations through the one-shot broker
- connect the passing trusted adjudication result to fresh draft publication planning
- project the final lifecycle state and release the exact claim after handoff
- prove the complete path against the installed broker and one owner-selected issue

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

Each execution account has its own usage identity and Codex app-server process. AubTown samples the 10,080 minute window, cumulative lifetime token activity, and active turns at least once per minute. It adds every positive percentage movement to a Los Angeles calendar-day ledger instead of subtracting one baseline from the latest sample. A quota-window reset therefore cannot erase consumption already observed that day. If the percentage meter moves backward while cumulative token activity rises inside the same window, the meters have diverged and execution stops. Missing, backward, or stale telemetry also stops dispatch.

The governor reserves 10 percent by default, enforces a hard daily ceiling, and compares current use with the permitted rolling-week trajectory. It throttles before the hard boundary and interrupts targeted active turns when continuing would consume the protected reserve. Authority and human blockers do not consume retry budget.

Prelaunch and active-turn quota enforcement are implemented. Every active turn rechecks its exact host and account against the protected observation journal every 30 seconds and heartbeats its exact Freed task, claim, binding, and custody epoch. Missing, malformed, future-dated, stale, or conflicting heartbeat or usage state fails closed. The daily admission-stop band blocks new work but lets a current turn continue until the separate hard daily interruption band. A hard result sends `turn/interrupt` for the exact thread and turn. If Codex does not finish cancellation within five seconds, Symphony closes the app-server transport. The telemetry monitor remains observation-only and does not become a second executor.

Future subscriptions and APIs use separate account records, credentials, quotas, and worker drivers. Queue, authority, conflict, custody, completion, and publication contracts remain unchanged.

## Crash recovery and custody

At startup, AubTown reconciles open issues, lifecycle comments, Freed tasks and claims, Symphony workspaces, local journals, branches, draft pull requests, host heartbeats, and checkpoint receipts. A mismatch blocks the issue. It never guesses that an absent in-memory retry means work is unclaimed. An append-only prelaunch receipt blocks the same exact claim after restart. Claims distinguish `claimed` from `running` custody. The active guard moves a claim to `running` and refreshes its authoritative heartbeat while a turn remains safe. A native pre-start and minute timer releases only an unlaunched `claimed` record whose heartbeat is older than 120 seconds and whose initial five-minute launch grace has elapsed. Release binds the last observed heartbeat, so a racing live heartbeat defeats the release. Stale `running` custody remains fenced for workspace restart or checkpoint transfer. A fresh, grace-period, or stranded running claim delays coordinator startup rather than risking duplicate execution. Workspace preparation is an idempotent prelaunch command, not a second scheduler or resident worker daemon.

Every unpublished terminal candidate can be captured as an encrypted, content-addressed Git state archive. At 24 hours offline, portable work may move to a compatible host after the old command is fenced, the custody epoch advances, and the destination verifies the exact restored state. Linux cannot satisfy a macOS-only validation requirement.

The coordinator-side transfer planner now turns fresh host evidence plus one verified checkpoint storage receipt into the exact next-epoch claim-transfer request and restore requirement. It rejects missing destination roots, stale destinations, incompatible lanes, bad signatures, wrong source hosts, mismatched claims or epochs, and impossible checkpoint time order. Freed's future `claim-transfer` response remains the authority boundary. A plan alone cannot fence the source or activate the destination.

## Security and publication

GitHub credentials stay host-side. The Coordinator App receives issue and label permissions. The Draft Publisher App receives repository-scoped contents and pull-request permissions only for an admitted publication plan. Workers receive neither raw credential.

The publication ceiling is draft pull request. Automatic readying, merge, release, deployment, issue closure, signing, secrets, migrations, provider traffic, and installed-soak conclusions remain outside v1 authority.

The dashboard binds to loopback and is exposed only through a private network such as Tailscale. Production uses native systemd on Linux and native worker tools on macOS. No Docker daemon is required.
