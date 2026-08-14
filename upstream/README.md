# Upstream components

## Symphony

AubTown uses OpenAI Symphony as its scheduler, workspace supervisor, Codex app-server runner, and operator status surface. The exact production candidate and the upstream tracking ref live in `symphony.lock.json`.

Production never executes a floating tag or branch. `npm run check:symphony:upstream` compares the reviewed production commit with upstream `main` without changing the lock. A newer commit is an update candidate, not an automatic deployment. Promotion requires the upstream test suite, AubTown compatibility tests, a disposable GitHub live run, and an explicit lock-file commit.

The first production candidate is newer than the v0.0.2 release because it includes upstream GitHub and GitLab authentication-alias scrubbing. AubTown applies a checksum-pinned patch series to that exact commit. The series adds protected refreshable GitHub App token files, capability-aware Linux and macOS routing, prelaunch and active-turn policy boundaries, and a compatible dependency lock with no current Hex security advisories. Its complete upstream suite passed with 303 tests and 6 explicit skips on 2026-08-13.

The reviewed patch series adds refreshable GitHub App tokens, capability-aware SSH routing, a fail-closed prelaunch command, and an active-run command that interrupts the exact Codex thread and turn at a hard quota boundary. AubTown's Freed workflow requires host-prepared worktrees and rejects Symphony-created empty directories. AubTown still needs the concrete Freed task-claim commands behind prelaunch and restart reconciliation. AubTown does not reimplement Symphony's polling loop, retry scheduler, dashboard, workspace supervision, or Codex app-server transport.

Docker is not part of the production or development contract. Symphony's Docker-based SSH fixture is optional upstream test machinery. AubTown will run the real Linux and macOS hosts directly.
