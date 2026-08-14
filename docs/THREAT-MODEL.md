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
| Coordinator restart dispatches an issue twice | Startup reconciles GitHub lifecycle state, current Freed claim, worktree, branch, journal, process custody, and draft PR before launch |
| Linux and Mac both own one issue | One task-scoped claim and custody epoch, plus a final authoritative reread before worker launch |
| A stale host resumes after transfer | Claim epoch advances only after checkpoint-backed transfer; old-epoch journal and publication requests are rejected |
| A host lies about being compatible | Enrolled immutable host capabilities and issue-qualified lane are checked by the scheduler patch and authority receipt |
| Symphony starts in an empty or foreign directory | Admission waits for helper-created host attestation; `after_create` rejects fallback directories and `before_run` verifies a clean worktree under the enrolled Freed repository |
| Conflicting tasks run concurrently | Qualified path domains and logical locks are compared against every active claim before admission |
| A GitHub label alone grants Freed execution | Dispatch also requires an exact active Freed task and supported claim-acquire receipt |
| A worker edits Freed authority files | Worker has no authority credential or canonical state-root access; bridge uses supported commands only |
| Coordinator credential reaches Codex | GitHub App token remains host-side and is scrubbed from the child environment |
| Installation token becomes long-lived | Broker refreshes a mode-restricted short-lived token; workflow contains no literal token |
| Malicious issue text executes shell | Qualification data is parsed as data; validation uses reviewed no-shell argv; fixed policy remains outside issue prose |
| Worker publishes unrelated content | Publication binds repository, branch, admitted base, exact reviewed head, prior remote head, draft number, and checkpoint identity |
| Worker merges, releases, or deploys | Separate credentials and explicit draft-only publication ceiling |
| Subscription spends the week in a day | Fresh usage telemetry, 10 percent reserve, daily hard ceiling, rolling-week trajectory, retry suppression, and targeted interruption |
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

The repository contains tested domain components and a reviewed Symphony patch, not an authorized live factory. Cloud provisioning, GitHub App installation, the Freed claim extension, native service installation, restart proof, and the real Freed pilot remain pending. The checked-in prelaunch executable denies every launch until the Freed bridge replaces that denial with a current task-scoped claim receipt.
