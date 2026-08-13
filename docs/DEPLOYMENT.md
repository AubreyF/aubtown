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

The checked-in Compose file is a local and single-node pilot baseline. It binds Restate ingress and administration to loopback. A reverse proxy must not expose them publicly. Use Tailscale routing or an SSH tunnel.

The local Compose baseline accepts unsigned Restate-to-service requests because both containers share a private local network. Production must generate a Restate ED25519 request-identity key, store its private key outside the repository, configure Restate with `RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE`, and pass the resulting public identity through `FREEDWORKS_RESTATE_IDENTITY_KEYS`. The service then rejects invocations not signed by that Restate instance.

## Bring-up sequence

1. Provision the host and encrypted persistent storage.
2. Install Tailscale and restrict inbound traffic with the provider firewall.
3. Create distinct service and worker users.
4. Check out Freedworks and Freed.
5. Authenticate the dedicated Codex account with device login into the host-specific `CODEX_HOME`.
6. Install the two repository-scoped GitHub Apps after their exact permissions are reviewed.
7. Start Restate and Freedworks.
8. Confirm request-identity validation, then register `http://control-plane:9080` with Restate from the private network.
9. Run read-only reconciliation and the shadow fixture.
10. Keep all writers disabled until the dry-run and authority-extension receipts pass.

## Host quota monitor

Run `npm run host:monitor` under systemd on Linux and launchd on macOS. The process starts Codex app-server inside that host's isolated `CODEX_HOME`, samples the actual rolling weekly window every 60 seconds, and submits observations to the durable account governor. Telemetry failures stop admission. When workers are enabled in the same host agent, the monitor also tracks their turn handles and sends targeted interrupts at the approved ceiling.

Set `FREEDWORKS_CODEX_MODEL` only after the account advertises that model as callable. Freedworks has no fallback model guess.

Do not point two host agents at the same `CODEX_HOME`. One execution account profile belongs to one host agent. Future extra subscriptions use separate OS users, credential directories, account IDs, and app-server processes.

## Provider portability

No host provisioning API is called by the control-plane domain. Terraform or OpenTofu modules may later implement Hetzner, DigitalOcean, or another provider. A provider module supplies compute, a persistent volume, firewall rules, backup storage, and DNS if needed. It does not alter scheduling or authority policy.

Reference: [Restate request identity](https://docs.restate.dev/services/security).
