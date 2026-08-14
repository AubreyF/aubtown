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
| A host lies about being compatible | Enrolled immutable host capabilities and issue-qualified lane are checked by the scheduler patch and authority receipt |
| Symphony starts in an empty or foreign directory | Admission waits for helper-created host attestation; `after_create` rejects fallback directories and `before_run` verifies a clean worktree under the enrolled Freed repository |
| Conflicting tasks run concurrently | Qualified path domains and logical locks are compared against every active claim before admission |
| A GitHub label alone grants Freed execution | Dispatch also requires an exact active Freed task and supported claim-acquire receipt |
| A worker edits Freed authority files | Worker has no authority credential or canonical state-root access; bridge uses supported commands only |
| Claim broker returns another task or claim | AubTown compares operation, task revision, claim, custody epoch, binding digest, conflict digest, and bridge identity before publishing an envelope |
| Claim commits but broker response is lost | One local retry reuses byte-identical canonical JSON and the same operation ID; Freed must return the original idempotent receipt |
| A candidate file attempts to grant authority | Candidates contain no admission receipt; only an exactly matching existing envelope or a successful reviewed broker response can produce executable authority |
| A changed candidate reuses stale authority | Envelope reuse requires an exact canonical match; any changed claim, host, task, quota observation, base, or binding goes back through the broker |
| A stale candidate acquires authority before final denial | Prelaunch revalidates claim age, route, policy, and quota against the actual launch instant before invoking the broker |
| A route changes between intended claim creation and candidate assembly | Deterministic assembly recomputes the route from fresh host and account state and rejects a claim naming another host |
| A dead host remains marked online | Heartbeats older than 120 seconds or dated in the future are treated as offline before route selection |
| A host impersonates another worker | Every observation is signed by the enrolled Ed25519 host key and bound to its route host ID |
| A signed host event is replayed after restart | The durable per-host sequence and envelope digest return only the original exact receipt; stale or conflicting reuse is rejected |
| A host reports another subscription | Heartbeat and quota account IDs must remain inside that host's enrollment scope |
| Coordinator credential reaches Codex | GitHub App token remains host-side and is scrubbed from the child environment |
| Installation token becomes long-lived | Broker refreshes a mode-restricted short-lived token; workflow contains no literal token |
| Malicious issue text executes shell | Qualification data is parsed as data; validation uses reviewed no-shell argv; fixed policy remains outside issue prose |
| Worker publishes unrelated content | Publication binds repository, branch, admitted base, exact reviewed head, prior remote head, draft number, and checkpoint identity |
| Worker merges, releases, or deploys | Separate credentials and explicit draft-only publication ceiling |
| Subscription spends the week in a day | Prelaunch recomputes the 10,080 minute rolling-week window and Los Angeles daily delta, preserves the 10 percent reserve, blocks new work at the daily ceiling, and interrupts targeted active turns at the hard limit |
| Usage telemetry disappears | New dispatch fails closed when observation age exceeds policy |
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
| Upstream memory loses blocked or retry state | GitHub, Freed, workspaces, journals, PRs, and checkpoints are reconciled at startup; uncertain state blocks |
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
- No transferred execution without the exact restored checkpoint receipt.
- No terminal handoff before encrypted checkpoint persistence.
- No publication for an unreviewed or changed work-product identity.
- No publication above draft pull request.
- No automatic merge, release, deployment, issue closure, signing, secret use, migration, or provider traffic.
- No floating Symphony branch or tag in production.
- No public coordinator or dashboard listener.

## Current gate

The repository contains tested domain components and a reviewed Symphony patch, not an authorized live factory. The native host gateway durably receives authenticated heartbeat and quota observations. The native planning collector gathers GitHub, Freed task, host, quota, local ref, pull-request, and worktree evidence into one protected read-only report. It refuses to treat missing claim evidence as an empty claim set. The native publisher creates protected non-authoritative candidates from trusted reconciler input. The checked-in prelaunch executable revalidates candidate freshness before authority, reuses only an exact matching envelope, and sends any changed dispatch through the reviewed Freed broker. It admits only a protected envelope carrying a valid current Freed claim, safe fresh quota, compatible host binding, and exact authority admission. It records the claim before returning success and blocks that claim after restart. Complete claim reconciliation and dispatch-intention assembly are not wired, non-observation gateway commands remain closed, and Freed cannot issue the required task claim. Cloud provisioning, GitHub App installation, the Freed claim extension, native service installation, full startup reconciliation, and the real Freed pilot remain pending.
