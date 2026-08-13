# Checkpoint custody

Freedworks can move unpublished repository state without moving credentials or an existing worktree directory.

## Capture

The source executor records:

- exact repository owner, repository name, default branch, and issue number
- exact repository and base Git heads
- one binary Git patch from the base head through the current working tree
- nonignored, physical, approved untracked files
- validation receipts
- claim ID, source host, and custody epoch

Ignored paths, dependencies, authentication caches, key files, symlinks, absolute paths, and parent-directory escapes are rejected. The archive is capped at 256 MiB and one untracked file at 64 MiB during the pilot.

The complete archive is encrypted with XChaCha20-Poly1305. The manifest is authenticated as associated data. Altering its claim, epoch, heads, path list, digest, or receipts makes decryption fail. The content-addressed local pilot store uses private directories, synchronized atomic publication, digest verification, and recoverable retirement instead of deletion.

The host execution journal persists capture, edge storage receipt, and catalog admission separately. A terminal executor receipt is withheld until all three stages succeed. After a restart, the host resumes at the first missing stage and never starts another worker turn for that command.

Manifest schema 2 binds the checkpoint to its repository, issue, claim, custody epoch, and source host. Schema 1 checkpoints were never used for real factory work and are not accepted by the remote transfer path.

## Transfer

After 24 hours without a source heartbeat, the durable custody workflow may select an online compatible host. Before transfer it resolves the requested content address through the ingress-private checkpoint catalog. That catalog accepts only a storage-edge-signed receipt submitted by the source host while it owns the exact current claim and epoch. The workflow ignores caller-supplied checkpoint manifests. Both the per-issue registry and repository scheduler advance exactly one epoch and change the destination worker and worktree.

The destination must be a clean worktree at the checkpoint's exact base head. Restore applies the binary patch and creates approved untracked files exclusively. It never overwrites an existing destination file. A stale source host cannot release or publish the new epoch.

## Remote data plane

Raw storage credentials remain in the Linux checkpoint edge. They never enter an executor or worker. An executor asks the signed host gateway for a five-minute transfer grant. Restate checks the current claim first. The coordinator signs the exact repository, issue, claim, current custody epoch, checkpoint epoch, host, operation, content address, byte length, issue time, expiry, and nonce.

The executor signs the HTTP method, exact path, grant nonce, body digest, and request time with its enrolled host key. The checkpoint edge verifies both signatures before accepting a body. Upload is content-addressed and idempotent. After the store confirms the write, the edge signs the reference, byte length, source host, grant nonce, complete manifest, and storage time with a receipt key held only by the storage edge. The control plane has only the receipt public key. It verifies the receipt and current claim before cataloging the checkpoint. Download checks the stored manifest against the grant before returning encrypted bytes. A transferred destination can download only the immediately prior checkpoint epoch or its current epoch. A host cannot substitute another repository, issue, claim, object, operation, path, size, or manifest.

The Linux pilot uses a private persistent volume behind this edge. An S3-compatible adapter can replace that volume without changing the grant or receipt protocols. The integration proof uses distinct Mac and Linux identities, rejects a forged storage receipt, records the valid receipt, advances custody from epoch 1 to epoch 2, compares the uploaded and downloaded bytes, restarts Restate and both edges, downloads again, releases the claim, and confirms that no new grant can be issued. The durable workflow proof separately confirms that a content address with no authenticated catalog receipt cannot transfer custody.

## Production storage

The local store remains useful for one-host tests. The shared adapter uses an S3-compatible object service with the same content-addressed payload format. It performs a conditional create, checks the content digest on every read, copies an authenticated object into a deterministic retired namespace before deleting the active name, and remains portable across storage vendors. Bucket versioning and retention are required in production so retirement stays recoverable.

The encryption key is never stored in the archive, Restate, GitHub, or the repository. During the single-factory pilot, a secret manager provisions the same 32-byte checkpoint key as a mode-restricted physical file on each authorized executor. The key is not copied during custody transfer and never enters a worker process or prompt. This pilot choice makes every enrolled executor a confidentiality boundary for all pilot checkpoints. Before adding less-trusted hosts or multiple tenants, replace it with distinct host credentials against an external key service or envelope-encryption service.
