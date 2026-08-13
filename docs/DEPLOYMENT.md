# Deployment contract

## Pilot topology

- One ordinary x86 Linux host
- Ubuntu 24.04 LTS or Debian 13
- Docker Engine and Compose
- Tailscale for dashboard and operator access
- Persistent volume for `/restate-data`
- Encrypted object storage for custody checkpoints
- Separate OS users or containers for coordinator and workers
- One local `CODEX_HOME` per execution account

The checked-in Compose file is a local and single-node pilot baseline. It binds Restate ingress, administration, the narrow host edge, and the checkpoint edge to loopback. Never expose Restate ingress or administration through a reverse proxy. Configure Tailscale Serve or an equivalent private proxy to forward only to the host edge on `127.0.0.1:8090` and checkpoint edge on `127.0.0.1:8091`. The host edge accepts only signed host submissions. The checkpoint edge accepts only grant-bound encrypted object transfer. Neither edge has a scheduler, arbitrary workflow, or admin route.

The local Compose baseline accepts unsigned Restate-to-service requests because both containers share a private local network. Production must generate a Restate ED25519 request-identity key, store its private key outside the repository, configure Restate with `RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE`, and pass the resulting public identity through `FREEDWORKS_RESTATE_IDENTITY_KEYS`. The service then rejects invocations not signed by that Restate instance.

Use `deploy/compose.production.yaml` with the baseline Compose file. It mounts the Restate identity private key and host enrollment file read-only from absolute host paths. One root initializer copies the checkpoint-grant private key into a `0400`, control-plane-owned Docker volume. A separate initializer copies the checkpoint-receipt private key into a different `0400`, checkpoint-edge-owned volume. The control plane receives only the receipt public key, and the checkpoint edge receives only the grant public key. Each initializer exits before its unprivileged service starts. The production override explicitly disables the local `IntegrationHarness`. All durable registries and workflows are Restate ingress-private. The systemd template composes both files. Actual keys, enrollments, account profiles, sequence state, and mutable service state stay outside Git.

The baseline Compose file enables `IntegrationHarness` for black-box tests on loopback. Never deploy that baseline alone on a persistent host. An unset harness flag fails closed. Values other than the exact strings `true` and `false` stop startup. `FREEDWORKS_ACCOUNT_PROFILES_FILE` maps each execution account ID to its driver, enabled state, and enrolled host IDs. It contains no credential. Startup rejects a profile that names a disabled host or an account outside that host's enrollment.

## Bring-up sequence

1. Provision the host and encrypted persistent storage.
2. Install Tailscale and restrict inbound traffic with the provider firewall.
3. Create distinct service and worker users.
4. Check out Freedworks and Freed.
5. Authenticate the dedicated Codex account with device login into the host-specific `CODEX_HOME`.
6. Install the two repository-scoped GitHub Apps after their exact permissions are reviewed.
7. Start Restate and Freedworks.
8. Confirm request-identity validation, then register `http://control-plane:9080` with Restate from the private Docker network.
9. Generate one Ed25519 host key on each executor. Keep the private key mode at `0600`. Add only its public key, fixed lane, and allowed account IDs to the Linux enrollment file.
10. Generate a separate Ed25519 checkpoint-grant key on Linux. Mount its private key only into the control plane and its public key only into the checkpoint edge.
11. Generate a different Ed25519 checkpoint-receipt key. Mount its private key only into the checkpoint edge and its public key only into the control plane.
12. Generate one random 32-byte pilot checkpoint-encryption key through the selected secret manager. Provision it independently as a mode `0600` file to each executor authorized to receive pilot custody. Never put it in an environment value, repository, prompt, checkpoint, or transfer response.
13. Configure each executor with private host-edge and checkpoint-edge URLs, its host private-key path, a host-local durable sequence file, execution journal, local encrypted checkpoint directory, checkpoint key file, and key reference. Never copy either the host key or sequence state to another host.
14. Start the Compose `checkpoint-transfer` profile. Its one-shot initializers give each unprivileged service only its own private key and give the checkpoint edge sole access to the `0700` persistent volume.
15. Run read-only reconciliation and the shadow fixture.
16. Keep all writers disabled until the dry-run and authority-extension receipts pass.

Configure separate private-key references for the Coordinator and Draft Publisher GitHub Apps. The broker mints one-repository installation tokens with operation-specific permissions. Read-only qualification receives `issues: read`. Lifecycle projection receives `issues: write` only after its phase gate. Draft publication receives `contents: write` and `pull_requests: write` only after an admitted exact-head publication plan. Workers receive none of these credentials.

## Host quota monitor

Run the built `dist/host-agent.js` under systemd on Linux and launchd on macOS. Templates live under `deploy/systemd` and `deploy/launchd`. Provision the Node version pinned by `.nvmrc` at `/opt/freedworks/node/bin/node`, or update the service template to another reviewed absolute path. Do not let a service manager guess among interactive shell installations.

The host agent starts Codex app-server inside that host's isolated `CODEX_HOME`, sends a signed heartbeat, samples the actual rolling weekly window every 60 seconds, and submits the signed observation to the durable account governor. The coordinator time-stamps acceptance. Telemetry failures stop admission. When workers are enabled in the same host agent, the monitor also tracks their turn handles and sends targeted interrupts at the approved ceiling.

Set `FREEDWORKS_EXECUTION_JOURNAL_FILE` to an absolute path in the executor's private state directory. The journal records the command, claim epoch, thread, turn, private finalization nonce, finalized candidate head, local result, and coordinator-report state before advancing each lifecycle step. A restarted host resumes a recorded app-server thread and never starts a second turn for the same command. If a crash lands between command acceptance and durable turn-handle storage, the executor fails closed for operator reconciliation because the start outcome is unknowable. The journal contains unpublished task metadata and a commit-finalization capability, so its parent is mode `0700` and its file is mode `0600`.

Set `FREEDWORKS_CHECKPOINT_LOCAL_STORE_ROOT`, `FREEDWORKS_CHECKPOINT_KEY_FILE`, `FREEDWORKS_CHECKPOINT_KEY_REFERENCE`, and `FREEDWORKS_CHECKPOINT_EDGE_URL` before starting an executor. The key file must be an absolute, physical, exactly 32-byte file inaccessible to group and other users. A terminal worker result remains unreported while capture, upload, or catalog admission is incomplete. The journal retries only the missing stage after restart.

Set `FREEDWORKS_GIT_EXECUTABLE` to the reviewed absolute Git binary used for workspace verification, custody capture, and restore. The service never resolves Git from its ambient `PATH`.

Set `FREED_REPOSITORY_ROOT` to the physical Freed checkout, `FREEDWORKS_WORKTREE_ROOT` to the host-owned root permitted to contain factory worktrees, and `FREEDWORKS_WORKTREE_HELPER` to Freed's absolute `scripts/worktree-add.sh` path. Provision the worktree root as a physical directory before the agent starts. The agent resolves physical paths, rejects destinations outside that root, and requires the helper to be a physical executable inside the configured repository. A first-epoch claim is never offered until the host creates or verifies the exact clean branch at the admitted base commit and records its signed workspace receipt. A transferred claim is never offered until the host restores the authenticated prior-epoch checkpoint, verifies the complete result from disk, and records its signed restore receipt.

Set `FREEDWORKS_CODEX_EXECUTABLE` to the reviewed absolute binary path and `FREEDWORKS_CODEX_VERSION` to the exact output of that binary's `--version` command. Startup resolves the physical binary, rejects group-writable or non-executable files, generates its version-specific app-server schema, and verifies the governed protocol surface before starting app-server. Review and update the pin after every Codex upgrade. Do not point a service at an unpinned executable found through `PATH`.

Set `FREEDWORKS_CODEX_MODEL` only after the account advertises that model as callable. Freedworks has no fallback model guess.

Do not point two host agents at the same `CODEX_HOME`. One execution account profile belongs to one host agent. Future extra subscriptions use separate OS users, credential directories, account IDs, and app-server processes.

Each executor sends a heartbeat to the durable host registry. A heartbeat older than 120 seconds removes the host from new routing. Custody alerts remain at 1 hour and 12 hours, with automatic portable-work transfer at 24 hours. The failover workflow rereads canonical source and destination heartbeats, the exact current claim, and the authenticated checkpoint receipt before it supersedes the old command or advances custody. The destination host then owns restoration. Merely advancing the epoch does not grant execution.

Every envelope includes the host ID, kind, payload, issued time, and a monotonically increasing sequence under an Ed25519 signature. Restate retains idempotent submissions for 8 days. A normal HTTP retry uses the same idempotency key. A reused sequence under another request identity is rejected, including after coordinator restart. Re-enrollment is required if a host changes lanes, keys, or account scope.

## Service installation

On Linux, copy the systemd templates to `/etc/systemd/system`, put nonsecret configuration and secret file references in root-owned files under `/etc/freedworks`, build the TypeScript output, and enable the units. The control-plane unit uses Docker Compose. A Linux executor can also run the host-agent unit under its unprivileged service account.

The default pilot stores encrypted checkpoint objects on the Linux persistent volume. The checkpoint edge can instead use an S3-compatible bucket through `FREEDWORKS_CHECKPOINT_S3_BUCKET`, `FREEDWORKS_CHECKPOINT_S3_REGION`, optional endpoint, and optional prefix. Prefer a workload or instance role. If the provider requires static credentials, mount a narrowly scoped credentials file into the checkpoint edge. Do not place storage secrets in Compose environment values or any worker container.

On macOS, install the launchd template only after replacing every placeholder and creating the listed state and log directories for the dedicated account. The template runs only the signed host agent. Linux remains the canonical Restate and authority host. The Mac keeps its Codex authentication, host key, sequence, worktrees, and native build state locally.

## Provider portability

No host provisioning API is called by the control-plane domain. Terraform or OpenTofu modules may later implement Hetzner, DigitalOcean, or another provider. A provider module supplies compute, a persistent volume, firewall rules, backup storage, and DNS if needed. It does not alter scheduling or authority policy.

Reference: [Restate request identity](https://docs.restate.dev/services/security).
