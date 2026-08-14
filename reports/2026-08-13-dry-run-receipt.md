# Durable dry-run receipt

Generated: 2026-08-13

Status: superseded historical evidence. AubTown removed Restate and the container runtime after this dry run. Nothing in this report describes the current production architecture.

Runtime:

- Restate Server 1.7.3
- Restate TypeScript SDK 1.16.5
- Node 24.14.1
- publication mode: none

Observed results:

1. An admitted runtime-neutral fixture completed the fake stages `plan`, `implement`, `validate`, `independent-review`, and `handoff`.
2. A second start using the same workflow ID returned HTTP 409 and did not execute another worker.
3. A fixture at 80 percent weekly usage returned `blocked` with quota action `interrupt` and no worker receipt.
4. The admitted workflow released its keyed claim after handoff.
5. Restate and the control service were restarted.
6. The workflow status after restart returned the original completed result and claim identity.
7. The repository scheduler admitted one bounded claim and rejected a second issue with an overlapping conflict domain.
8. A custody transfer advanced exactly from epoch 1 to epoch 2. A stale epoch 1 release was rejected.
9. The quota monitor selected the actual 10,080 minute app-server window and interrupted a tracked fake turn at the weekly ceiling.
10. Host registry reads marked a fresh Linux heartbeat online and the same host offline after its liveness bound.
11. The durable custody workflow transferred a 25-hour-offline Mac claim to Linux, changed the worktree, and advanced both claim registries to epoch 2.
12. Startup reconciliation admitted only matching issue, authority, branch, worktree, host, and custody evidence.
13. The checkpoint implementation encrypted and reconstructed tracked and approved untracked work without plaintext storage.

The run contacted no worker model, wrote nothing to GitHub, created no Freed worktree, and acquired no Freed lease.
