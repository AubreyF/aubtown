# Freedworks agent instructions

## Authority

- GitHub Issues are the only canonical backlog.
- Project authority adapters may grant execution only through each repository's supported control plane.
- Never edit a repository authority manifest, lease, or credential file directly.
- One issue has one active claim, one custody epoch, one worktree, one branch, and one worker owner.
- An issue label does not grant execution authority by itself.

## Publication

- Every external body starts with `(AI Generated).` followed by a blank line.
- External titles and branch names contain no worker product names or authorship giveaways.
- The pilot publication ceiling is a draft pull request.
- No automatic merge, release, deployment, issue closure, provider traffic, secret mutation, signing, or production migration.

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
