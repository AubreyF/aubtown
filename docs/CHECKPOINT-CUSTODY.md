# Checkpoint custody

Freedworks can move unpublished repository state without moving credentials or an existing worktree directory.

## Capture

The source executor records:

- exact repository and base Git heads
- one binary Git patch from the base head through the current working tree
- nonignored, physical, approved untracked files
- validation receipts
- claim ID, source host, and custody epoch

Ignored paths, dependencies, authentication caches, key files, symlinks, absolute paths, and parent-directory escapes are rejected. The archive is capped at 256 MiB and one untracked file at 64 MiB during the pilot.

The complete archive is encrypted with XChaCha20-Poly1305. The manifest is authenticated as associated data. Altering its claim, epoch, heads, path list, digest, or receipts makes decryption fail. The content-addressed local pilot store uses private directories, synchronized atomic publication, digest verification, and recoverable retirement instead of deletion.

## Transfer

After 24 hours without a source heartbeat, the durable custody workflow may select an online compatible host. Before transfer it verifies the checkpoint belongs to the current claim and current epoch. Both the per-issue registry and repository scheduler advance exactly one epoch and change the destination worker and worktree.

The destination must be a clean worktree at the checkpoint's exact base head. Restore applies the binary patch and creates approved untracked files exclusively. It never overwrites an existing destination file. A stale source host cannot release or publish the new epoch.

## Production storage

The local store is the pilot implementation. Production uses an encrypted object store adapter with the same content-addressed contract. The encryption key is resolved by an external host key provider and is never stored in the archive, Restate, GitHub, or the repository.
