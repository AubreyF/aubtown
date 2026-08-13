# Freedworks

Freedworks is a working title for a governed software factory. It uses GitHub Issues as the only work queue, a repository-specific authority bridge for execution permission, durable orchestration, and replaceable worker drivers.

Freed is the only enrolled repository in the initial pilot. The architecture retains a uniform repository contract so other repositories can be added later without becoming active now.

## Pilot boundaries

- `factory:ready` plus active repository authority are both required.
- Aubrey applies `factory:ready` during the pilot.
- Eligible issues must carry `debt`. `automation-triage` is excluded.
- Phase 1 is read-only.
- The first writer runs alone.
- The publication ceiling is a draft pull request.
- Provider-visible work and sensitive operational lanes cannot execute unattended.

## Local development

```sh
nvm use
npm install
npm run check
npm run shadow -- --issues test/fixtures/freed-issues.json
npm run test:pilot-readiness
npm run test:host-ingress
```

The shadow command reads issue JSON and prints deterministic qualification reports. It does not contact GitHub or mutate Freed.

`test:pilot-readiness` runs the complete candidate-to-draft contract against a temporary Git repository with fake external edges. It performs no network writes and consumes no subscription quota.

The host-side GitHub shadow reader is also read-only:

```sh
FREEDWORKS_GITHUB_TOKEN='<installation token>' npm run shadow:github
```

Use a short-lived Coordinator App installation token in deployment. The token stays in the host process environment and is never passed to a worker.

`test:host-ingress` rebuilds the local Docker stack, enrolls a disposable Ed25519 Mac identity, and restarts Restate. It proves that the narrow host edge accepts the enrolled identity, rejects tampering and replay, and exposes no general Restate route. It leaves only the disposable public key in the running service configuration. The private key is destroyed with the test directory.

## Repository map

- `src/domain`: portable work, host, authority, quota, and custody contracts
- `src/policy`: deterministic admission, conflict, quota, and failover decisions
- `src/adapters/freed`: the stronger Freed authority bridge
- `src/adapters/execution-admission.ts`: the portable exact-dispatch binding after repository authority
- `src/drivers`: replaceable worker interfaces, beginning with Codex app-server
- `src/orchestration`: durable Restate services
- `src/supervision`: host-side quota and worker lifecycle monitors
- `src/security`: host identity, signed envelopes, and durable replay sequences
- `src/gateway`: the narrow remote-host edge in front of loopback-only Restate ingress
- `src/checkpoints`: encrypted Git custody, shared storage adapters, transfer grants, and host proofs
- `src/projection`: deterministic lifecycle label and single-comment plans
- `docs`: architecture, threat model, deployment, and phase gates
