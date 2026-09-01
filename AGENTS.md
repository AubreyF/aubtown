# AubTown agent instructions

## Authority

- GitHub Issues are the only canonical backlog.
- Project authority adapters may grant execution only through each repository's supported control plane.
- Never edit a repository authority manifest, lease, or credential file directly.
- One issue has one active claim, one custody epoch, one worktree, one branch, and one worker owner.
- An issue label does not grant execution authority by itself.

### Supervising task authority

- Keep user-granted authority for the supervising development task separate from the authority granted to Factory workers.
- The newest explicit user instruction governs the supervising task and supersedes older task prompts, summaries, heartbeats, and approval checkpoints when they conflict.
- When the user grants Level 7 or equivalent full task authority for the active goal, continue through in-scope commits, pushes, pull requests, exact-head merges, installation, configuration, and authority recovery without requesting the same approval again.
- Under that grant, stop only for a genuine external blocker, a material ambiguity the repository and current evidence cannot resolve, an action outside the stated goal, provider-visible behavior outside the approved boundary, or a quota or safety gate that the user did not authorize changing.
- Never interpret Factory worker admission gates as a requirement for the supervising task to obtain redundant user approval. Never interpret supervising task authority as permission for a Factory worker to approve its own work or exceed its signed envelope.

## Publication

- Every external body starts with `(AI Generated).` followed by a blank line.
- External titles and branch names contain no worker product names or authorship giveaways.
- The pilot publication ceiling for Factory-generated work is a draft pull request.
- A Factory worker cannot automatically merge, release, deploy, close an issue, contact a provider, mutate a secret, sign an artifact, or run a production migration.
- This Factory publication ceiling does not prohibit the supervising development task from merging repository-maintenance or control-plane repair pull requests when its current user-granted authority permits that action and exact-head checks pass.

## Safety

- Fail closed when authority, usage telemetry, host identity, custody, repository state, or conflict state is stale or ambiguous.
- Do not move authentication state between hosts.
- Checkpoints contain repository work and receipts only. They exclude credentials, dependency directories, ignored files, and unapproved untracked files.
- Keep hosting, worker, tracker, authority, storage, and notification integrations behind explicit interfaces.

## Engineering

- Use the Node version pinned in `.nvmrc`.
- Use TypeScript strict mode.
- Add tests for every authority, quota, custody, conflict, or publication decision.
- Keep provider-specific deployment code out of the domain packages.
- Update the phase document when a phase contract changes.
