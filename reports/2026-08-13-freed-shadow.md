# Freed shadow qualification

Generated: 2026-08-13

Mode: read-only

## Census

- Open debt issues read: 53
- Dispatch-eligible issues: 0
- Issues carrying `factory:ready`: 0
- GitHub writes: 0
- Workers launched: 0

The result is correct. Debt alone does not grant authority. Current issues also lack a separate exact-validation field and declared path or logical conflict domains, so the qualifier blocks them even before consulting Freed authority.

## Representative review

Five high-scoring issue reports were compared with their current GitHub bodies and pull request closure references.

### Recommended candidate 1: issue 1117

`Stabilize Friends graph lane geometry validation`

This is a focused runtime-neutral test-contract repair with concrete failure evidence and no linked closing pull request. It is a suitable first pilot only if qualification keeps the implementation test-only. A product layout change would reclassify it as behavioral and remove it from the initial pilot.

Proposed qualification additions:

- owned path: `packages/desktop/tests/e2e/theme-switching.spec.ts`
- logical lock: `desktop-e2e-layout-contract`
- validation: focused repeated test, exact-head Validation, and post-merge dev Validation
- host lane: Linux Chromium for implementation, macOS only if native behavior becomes relevant

### Recommended candidate 2: issue 1217

`Stop feed performance probes treating absent samples as zero`

This is measurement integrity work. It has clear negative and positive contracts and does not require provider traffic. Its scope spans several probe types, so planning must first bind the exact probe files and preserve runtime behavior.

Proposed qualification additions:

- logical lock: `desktop-performance-measurement`
- validation: deterministic no-sample, valid-zero, and valid-nonzero fixtures
- host lane: Linux
- publication: draft pull request only

### Recommended candidate 3: issue 1116

`Bound nightly tooling smoke test runtime`

This is runtime-neutral CI reliability work with a concrete stalled run, known shard ownership, and explicit cleanup requirements. It is appropriate after the fake-worker restart tests because its own subject is process supervision and timeout behavior.

Proposed qualification additions:

- owned paths: `scripts/nightly-self-improve.test.mjs` and the tooling smoke runner selected during planning
- logical locks: `tooling-smoke`, `child-process-supervision`
- validation: deliberately stalled fixture fails within its documented bound and leaves no orphan process
- host lane: Linux

## Exclusions

- Issue 1292 touches YouTube consent history and can cross a provider behavior boundary. It is not an initial unattended candidate.
- Issue 1244 reports 21 native Clippy errors across several subsystems. It is too broad for the first single-root-cause pilot.
- Issue 1271 concerns production deployment and is prohibited by the pilot publication ceiling.

## Authority preflight

The read-only Freed task-list command failed with `authority_generation_conflict`: `Control event history pending staging does not match one exact owning operation namespace.`

Freedworks therefore records repository authority as unhealthy and cannot dispatch. It will not inspect around the conflict, edit authority files, acquire another actor, or use `nightly-writer`. Supported Freed host recovery must reconcile this state before the single-worker pilot.

## Schema proposal for Freed

Keep the uniform lifecycle labels. Extend the Freed debt issue form or its qualification projection with these explicit fields:

- exact validation commands or outcomes
- owned paths
- logical conflict domains
- required host lane
- behavioral classification
- provider set and approval state
- owner-review surface
- release or migration risk

The outer fields remain portable. The Freed adapter applies its stronger task, lease, behavior-slot, provider, installed-build, and soak contracts beneath them.
