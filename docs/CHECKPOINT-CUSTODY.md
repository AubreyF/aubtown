# Checkpoint custody

AubTown moves unpublished Git state, not worktree directories, credentials, or running agent processes.

## Capture

A terminal or interrupted worker candidate is captured from a trusted host journal. The archive binds:

- repository and issue
- claim ID and custody epoch
- source host
- admitted base commit and current repository head
- binary tracked patch
- approved nonignored untracked files
- validation receipts
- creation time

Ignored paths, dependencies, authentication caches, key files, symlinks, absolute paths, and parent escapes are rejected. Pilot limits are 256 MiB per archive and 64 MiB per untracked file.

The complete archive uses XChaCha20-Poly1305. Its manifest is authenticated associated data. Changing the claim, epoch, heads, paths, digest, or receipts makes decryption fail. Storage is content-addressed and verifies bytes on every read.

Candidate finalization, capture, remote storage, and coordinator acknowledgement are separate journal stages. A crash resumes the first missing stage. It never reruns an already completed worker merely because a receipt response was lost.

## Transfer

After 24 hours without a source heartbeat, AubTown may transfer only portable work to a compatible online host.

The transfer sequence is:

1. Re-read the current GitHub lifecycle state and Freed execution claim.
2. Confirm the exact source heartbeat interval and authenticated checkpoint receipt.
3. Fence or supersede the old command.
4. Advance exactly one custody epoch through the supported Freed claim-transfer operation.
5. Create the destination worktree through `scripts/worktree-add.sh` at the authenticated base.
6. Download and decrypt the exact content address.
7. Restore tracked and approved untracked state without overwriting an existing file.
8. Recompute the complete archive from disk and require byte-equivalent identity.
9. Record the destination receipt before resuming execution.

A returning source host with the old epoch cannot resume, release, or publish the transferred claim.

Linux may inherit runtime-neutral work. A macOS-only task remains blocked until a compatible Mac executor is online.

## Storage boundary

The Linux checkpoint edge owns local or S3-compatible storage credentials. An executor receives a five-minute grant bound to one repository, issue, claim, epoch, host, operation, content address, and byte length.

The executor signs the method, path, grant nonce, body digest, and request time with its enrolled host key. The storage edge signs the persisted reference and manifest. The coordinator verifies that receipt against current claim custody before accepting it.

Workers and Codex prompts never receive raw storage credentials or the checkpoint encryption key.

## Key model

The single-factory pilot may provision the same 32-byte checkpoint key as a mode-0600 file to the two equally trusted executors. It is never stored in GitHub, Symphony, Freed task state, the repository, or the archive.

Before enrolling less-trusted hosts, multiple tenants, or external workers, replace the shared pilot key with per-host envelope encryption backed by an external key service.
