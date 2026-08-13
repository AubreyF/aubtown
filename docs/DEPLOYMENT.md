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

The checked-in Compose file is a local and single-node pilot baseline. It binds Restate ingress, administration, and the narrow host edge to loopback. Never expose Restate ingress or administration through a reverse proxy. Configure Tailscale Serve or an equivalent private proxy to forward only to the host edge on `127.0.0.1:8090`. The host edge accepts only signed host submissions. It has no scheduler, claim, workflow, or admin route.

The local Compose baseline accepts unsigned Restate-to-service requests because both containers share a private local network. Production must generate a Restate ED25519 request-identity key, store its private key outside the repository, configure Restate with `RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE`, and pass the resulting public identity through `FREEDWORKS_RESTATE_IDENTITY_KEYS`. The service then rejects invocations not signed by that Restate instance.

Use `deploy/compose.production.yaml` with the baseline Compose file. It mounts the Restate identity private key and host enrollment file read-only from absolute host paths. The systemd template composes both files. Actual keys, enrollments, account profiles, sequence state, and mutable service state stay outside Git.

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
10. Configure each executor with a private host-edge URL, a private-key path, and a host-local durable sequence file. Never copy either the key or sequence state to another host.
11. Run read-only reconciliation and the shadow fixture.
12. Keep all writers disabled until the dry-run and authority-extension receipts pass.

Configure separate private-key references for the Coordinator and Draft Publisher GitHub Apps. The broker mints one-repository installation tokens with operation-specific permissions. Read-only qualification receives `issues: read`. Lifecycle projection receives `issues: write` only after its phase gate. Draft publication receives `contents: write` and `pull_requests: write` only after an admitted exact-head publication plan. Workers receive none of these credentials.

## Host quota monitor

Run the built `dist/host-agent.js` under systemd on Linux and launchd on macOS. Templates live under `deploy/systemd` and `deploy/launchd`. Provision the Node version pinned by `.nvmrc` at `/opt/freedworks/node/bin/node`, or update the service template to another reviewed absolute path. Do not let a service manager guess among interactive shell installations.

The host agent starts Codex app-server inside that host's isolated `CODEX_HOME`, sends a signed heartbeat, samples the actual rolling weekly window every 60 seconds, and submits the signed observation to the durable account governor. The coordinator time-stamps acceptance. Telemetry failures stop admission. When workers are enabled in the same host agent, the monitor also tracks their turn handles and sends targeted interrupts at the approved ceiling.

Set `FREEDWORKS_CODEX_MODEL` only after the account advertises that model as callable. Freedworks has no fallback model guess.

Do not point two host agents at the same `CODEX_HOME`. One execution account profile belongs to one host agent. Future extra subscriptions use separate OS users, credential directories, account IDs, and app-server processes.

Each executor sends a heartbeat to the durable host registry. A heartbeat older than 120 seconds removes the host from new routing. Custody alerts remain at 1 hour and 12 hours, with automatic portable-work transfer at 24 hours.

Every envelope includes the host ID, kind, payload, issued time, and a monotonically increasing sequence under an Ed25519 signature. Restate retains idempotent submissions for 8 days. A normal HTTP retry uses the same idempotency key. A reused sequence under another request identity is rejected, including after coordinator restart. Re-enrollment is required if a host changes lanes, keys, or account scope.

## Service installation

On Linux, copy the systemd templates to `/etc/systemd/system`, put nonsecret configuration and secret file references in root-owned files under `/etc/freedworks`, build the TypeScript output, and enable the units. The control-plane unit uses Docker Compose. A Linux executor can also run the host-agent unit under its unprivileged service account.

On macOS, install the launchd template only after replacing every placeholder and creating the listed state and log directories for the dedicated account. The template runs only the signed host agent. Linux remains the canonical Restate and authority host. The Mac keeps its Codex authentication, host key, sequence, worktrees, and native build state locally.

## Provider portability

No host provisioning API is called by the control-plane domain. Terraform or OpenTofu modules may later implement Hetzner, DigitalOcean, or another provider. A provider module supplies compute, a persistent volume, firewall rules, backup storage, and DNS if needed. It does not alter scheduling or authority policy.

Reference: [Restate request identity](https://docs.restate.dev/services/security).
