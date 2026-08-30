# Threat model

## Protected assets

- repository source and unpublished work
- GitHub App and subscription credentials
- daily and rolling-week Codex capacity
- Freed task, lease, claim, event, and outcome integrity
- one-current-owner custody
- provider, owner-review, publication, release, and deployment boundaries
- checkpoint confidentiality and integrity

## Trust boundaries

The Linux coordinator, authority broker, checkpoint edge, Linux worker, and Mac worker are separate processes and may use separate operating-system users. GitHub and the Codex service are external systems. Issue prose and repository code are untrusted worker inputs.

Symphony may schedule only after AubTown admission. AubTown may admit only after GitHub and Freed authority agree. Neither local journal state nor Symphony memory can create authority.

## Principal threats and controls

| Threat | Control |
| --- | --- |
| Two issues are dispatched as the same work | Exact repository and issue identity bind the Freed task, claim, workspace, branch, prompt, receipts, and status projection |
| Coordinator restart dispatches an issue twice | Exclusive append-only prelaunch receipt blocks the same exact claim; startup reconciliation checks GitHub, Freed, worktree, branch, process custody, and draft PR before issuing a replacement claim |
| Linux and Mac both own one issue | One task-scoped claim and custody epoch, plus a final authoritative reread before worker launch |
| A stale host resumes after transfer | Claim epoch advances only after checkpoint-backed transfer; old-epoch journal and publication requests are rejected |
| Offline transfer uses the wrong checkpoint | Coordinator verifies the checkpoint edge signature and binds claim, repository, issue, source host, prior epoch, content address, time order, destination, and exact next epoch before proposing transfer |
| A host lies about being compatible | Enrolled immutable host capabilities and issue-qualified lane are checked by the scheduler patch and authority receipt |
| Symphony starts in an empty or foreign directory | Admission invokes one fixed remote preparer after claim acquisition and verifies its exact receipt; `after_create` rejects fallback directories and `before_run` verifies a clean worktree under the enrolled Freed repository |
| A completion hook acts on another claim or workspace | A content-addressed manifest binds exact custody and an atomic pointer selects it by physical worktree; digest, path, claim, host, epoch, qualification, and finalization identity are rechecked on load |
| Worker code tampers with executor custody | The mode-0700 handoff root sits outside the workspace-write sandbox, contains no credential, and exposes only mode-0600 manifests to trusted host hooks |
| A completion retry creates another commit or spends another Codex turn | Exact commit message and nonce verification make completion idempotent; the pre-run guard blocks a workspace with an existing completion receipt before app-server startup |
| Completion publishes stale custody | The executor hook has no publication or authority credential; coordinator reconciliation must recheck the current claim before validation, review, or draft publication |
| A forged completion is sent to validation | The coordinator recomputes the admitted handoff digest, reads the protected bundle through the enrolled SSH alias, and binds the receipt, patch digest, implementation turn, task, and exact live claim |
| Restart spends another reviewer turn | The host stores the exact reviewer thread and turn before waiting, resumes that handle after restart, and returns an existing immutable result without another start |
| Crash loses whether reviewer start occurred | A persisted `review-starting` boundary without a durable handle is treated as ambiguous and fenced; it cannot silently spend another review turn |
| Review crosses the subscription ceiling | The host rereads usage before starting review, samples during the active turn, and interrupts the exact reviewer handle at a hard daily or rolling-week boundary |
| Issue text injects a remote shell command during workspace setup | SSH receives only strict host IDs, fixed shell-safe absolute command paths, and one schema-checked base64url payload; issue prose is never interpolated into the remote command |
| Conflicting tasks run concurrently | Qualified path domains and logical locks are compared against every active claim before admission |
| A missing claim is mistaken for free capacity | Planning requires one complete broker claim-list response with unique task and claim IDs; missing or malformed evidence blocks |
| A GitHub label alone grants Freed execution | Dispatch also requires an exact active Freed task and supported claim-acquire receipt |
| A worker edits Freed authority files | Worker has no authority credential or canonical state-root access; bridge uses supported commands only |
| Claim broker returns another task or claim | AubTown compares operation, task revision, claim, custody epoch, binding digest, conflict digest, and bridge identity before publishing an envelope |
| Claim commits but broker response is lost | One local retry reuses byte-identical canonical JSON and the same operation ID; Freed must return the original idempotent receipt |
| Reconciliation releases a claim that resumed concurrently | Release binds the exact last heartbeat and custody epoch; a racing active-run heartbeat makes the broker reject stale release |
| A candidate file attempts to grant authority | Candidates contain no admission receipt; only an exactly matching existing envelope or a successful reviewed broker response can produce executable authority |
| A changed candidate reuses stale authority | Envelope reuse requires an exact canonical match; any changed claim, host, task, quota observation, base, or binding goes back through the broker |
| A stale candidate acquires authority before final denial | Prelaunch revalidates claim age, route, policy, and quota against the actual launch instant before invoking the broker |
| A route changes between intended claim creation and candidate assembly | Deterministic assembly recomputes the route from fresh host and account state and rejects a claim naming another host |
| A dead host remains marked online | Heartbeats older than 120 seconds or dated in the future are treated as offline before route selection |
| A host impersonates another worker | Every observation is signed by the enrolled Ed25519 host key and bound to its route host ID |
| An SSH alias routes to an unintended host or weakens authentication | Root-owned config, strict known-host pinning, per-host key aliases, one identity, public-key-only authentication, bounded connection policy, and use-time validation before probes and worktree creation |
| A signed host event is replayed after restart | The durable per-host sequence and envelope digest return only the original exact receipt; stale or conflicting reuse is rejected |
| A host reports another subscription | Heartbeat and quota account IDs must remain inside that host's enrollment scope |
| Coordinator credential reaches Codex | GitHub App token remains host-side and is scrubbed from the child environment |
| Installation token becomes long-lived | Broker refreshes a mode-restricted short-lived token; workflow contains no literal token |
| Malicious issue text executes shell | Qualification data is parsed as data; validation uses reviewed no-shell argv; fixed policy remains outside issue prose |
| Worker publishes unrelated content | Publication binds repository, branch, admitted base, exact reviewed head, prior remote head, draft number, and checkpoint identity |
| Worker merges, releases, or deploys | Separate credentials and explicit draft-only publication ceiling |
| Subscription spends the week in a day | Prelaunch recomputes the 10,080 minute window, accumulates gross positive percentage movement in a Los Angeles daily ledger, cross-checks cumulative token activity, stops autonomous work at 80 percent rolling-week usage, stops new admission at 30 percent daily usage, and interrupts targeted active turns at 35 percent daily usage |
| A moving reset estimate or retreating rolling-window percentage fabricates or hides use | Reset estimates do not count as consumption. Previously observed daily consumption never decreases, later positive movement still accumulates, and backward cumulative activity fails closed |
| Usage telemetry disappears | New dispatch fails closed when observation age exceeds policy; an active turn receives an exact protocol interrupt and a hard transport cutoff after the grace period |
| Retry loop consumes quota on a human blocker | Authority, approval, rate-limit, and human-input blockers do not receive automatic subscription retries |
| Candidate is lost before acknowledgement | Encrypted content-addressed checkpoint completes before terminal handoff is acknowledged |
| Checkpoint is modified | XChaCha20-Poly1305 authentication plus content digest and signed storage receipt |
| Checkpoint leaks credentials | Ignored and denylisted paths are excluded; only approved untracked files enter the encrypted archive |
| Storage credential reaches executor | Separate checkpoint edge owns storage credential and accepts claim-bound short-lived grants |
| Validation or review targets another candidate | Receipts bind the full checkpoint-backed work-product identity and immutable base |
| Implementation approves itself | Independent review requires a fresh thread with read-only, network-disabled policy |
| GitHub status comment is spoofed | Only configured App author and schema are accepted; signed coordinator fingerprints are required for standby election |
| Two standby coordinators promote themselves | Earliest valid immutable GitHub comment ID wins, followed by a propagation delay and final reread before any launch |
| Upstream Symphony changes silently | Production commit and source checksum are immutable; tracking and promotion are separate operations |
| Installed runtime differs from reviewed pilot | Native readiness audit rechecks the immutable executable path, patch digests, workflow, compiled guards, broker, and exact issue dispatch before launch |
| Removed code or changed dependencies survive into a host release | Every build starts from an empty `dist`, installs locked production dependencies without lifecycle scripts, and verifies the exact root-owned release manifest before activation |
| Coordinator publisher key requests a shell beside the GitHub App key | Server-side `authorized_keys` forces one root-owned gateway that accepts only `probe` and `publish <payload>` and rechecks its protected runtime before either operation |
| Selected executor is missing or misconfigured | A fresh SSH probe checks its physical checkout, writable workspace root, private handoff root, exact base ref, pinned Node and Git runtimes, helper, and preparer, then the coordinator binds that report to the selected dispatch |
| Upstream memory loses blocked or retry state | The active guard marks running custody and heartbeats exact authority; reconciliation releases only expired unlaunched claims, while running or ambiguous custody stays fenced |
| Dashboard becomes public | Loopback binding plus private Tailscale exposure only |
| Another backlog appears | No AubTown ticket database, Markdown ticket queue, or CAR dispatcher |

## Fail-closed invariants

- One issue, one current Freed execution claim, one custody epoch.
- One claim, one branch, one worktree, one worker owner.
- No dispatch from `debt` alone.
- No dispatch without `factory:ready`, complete qualification, fresh quota, and compatible host evidence.
- No dispatch authority from a candidate file alone.
- No direct mutation of Freed authority files.
- No provider-visible or sensitive unattended execution.
- No new dispatch when subscription telemetry is stale or protected capacity would be crossed.
- No active Symphony turn continues past the hard quota signal and five-second cancellation grace.
- No transferred execution without the exact restored checkpoint receipt.
- No terminal handoff before encrypted checkpoint persistence.
- No publication for an unreviewed or changed work-product identity.
- No trusted completion action without a matching active-workspace handoff digest and exact custody identity.
- No second worker turn after a trusted completion receipt exists.
- No trusted adjudication without a current exact Freed claim and matching active implementation turn.
- No independent review start from stale or hard-blocked subscription telemetry.
- No repeated reviewer start across an ambiguous crash boundary.
- No candidate commit containing a path outside qualified ownership.
- No publication above draft pull request.
- No automatic merge, release, deployment, issue closure, signing, secret use, migration, or provider traffic.
- No floating Symphony branch or tag in production.
- No public coordinator or dashboard listener.

## Current gate

The repository contains tested domain components and a reviewed Symphony patch, not an authorized live factory. The native host gateway durably receives authenticated heartbeat and quota observations. The native planning collector gathers GitHub, Freed task, complete broker claim, host, quota, local ref, pull-request, and worktree evidence into one protected read-only report. It refuses to treat missing claim evidence as an empty claim set. A deterministic second stage derives one proposed initial claim, route, branch, target, and host-specific `GH-<issue>` worktree or records why it cannot. This proposal carries no authority. The native publisher creates protected non-authoritative candidates from trusted reconciler input. The checked-in prelaunch executable revalidates candidate freshness before authority, reuses only an exact matching envelope, and sends any changed dispatch through the reviewed Freed broker. After exact claim acquisition, it prepares the worktree through the existing Symphony SSH lane. The executor persists exact handoff custody before returning its remote receipt. AubTown verifies that receipt before publishing the envelope. It admits only a protected envelope carrying a valid current Freed claim, safe fresh quota, compatible host binding, exact authority admission, and helper-created workspace. It records the claim before returning success and blocks that claim after restart. The pinned runner rechecks protected usage and heartbeats exact authority throughout the turn. It can interrupt the exact thread and turn with a hard transport cutoff. Trusted completion creates one owned-path commit and immutable receipt. Coordinator reconciliation verifies that completion against fresh GitHub, Freed task, claim, quota, and implementation-turn evidence. The custody host runs exact reviewed validation and a separate read-only review with active quota interruption, then returns one immutable restart-safe result. The gated completion path records and executes draft publication, human-review projection, and exact claim cleanup as an immutable resumable transaction. Failed adjudication follows a separate immutable blocked-handoff transaction that never publishes a draft and still releases the completed worker claim. Pre-start and periodic reconciliation release only stale claims whose heartbeat cannot race the release. The native readiness audit proves that the installed runtime and exact dispatch remain coherent, but it cannot manufacture missing Freed authority. Merged Freed PR #1491 supplies the claim contract and AubTown builds a one-shot broker that keeps the coordinator lease out of worker state. Cloud provisioning, GitHub App installation, installation of the claim extension and broker, installed end-to-end restart proof, and the real Freed pilot remain pending.
