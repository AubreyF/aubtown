# Upstream components

## Symphony

AubTown uses OpenAI Symphony as its scheduler, workspace supervisor, Codex app-server runner, and operator status surface. The exact production candidate and the upstream tracking ref live in `symphony.lock.json`.

Production never executes a floating tag or branch. `npm run check:symphony:upstream` compares the reviewed production commit with upstream `main` without changing the lock. A newer commit is an update candidate, not an automatic deployment. Promotion requires the upstream test suite, AubTown compatibility tests, a disposable GitHub live run, and an explicit lock-file commit.

The first production candidate is newer than the v0.0.2 release because it includes upstream GitHub and GitLab authentication-alias scrubbing. AubTown still needs a narrow reviewed extension for capability-aware worker routing, mixed Linux and macOS workers, Freed worktree creation, quota admission, and restart reconciliation. Those changes belong in an auditable patch series against the pinned commit. AubTown does not reimplement Symphony's polling loop, retry scheduler, dashboard, workspace supervision, or Codex app-server transport.

Docker is not part of the production or development contract. Symphony's Docker-based SSH fixture is optional upstream test machinery. AubTown will run the real Linux and macOS hosts directly.
