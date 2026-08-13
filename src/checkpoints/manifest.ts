import { createHash } from "node:crypto";
import type { CustodyCheckpoint, DispatchClaim } from "../domain/types.js";
import { isCheckpointPathAllowed } from "../policy/custody.js";

export interface CheckpointInput {
  readonly claim: DispatchClaim;
  readonly repositoryHead: string;
  readonly baseHead: string;
  readonly patch: Uint8Array;
  readonly includedUntrackedPaths: readonly string[];
  readonly validationReceipts: readonly string[];
  readonly createdAt: string;
}

function assertGitSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase 40-character Git SHA.`);
  }
}

export function createCheckpointManifest(input: CheckpointInput): CustodyCheckpoint {
  assertGitSha(input.repositoryHead, "repositoryHead");
  assertGitSha(input.baseHead, "baseHead");
  const invalidPath = input.includedUntrackedPaths.find(
    (path) => !isCheckpointPathAllowed(path),
  );
  if (invalidPath !== undefined) {
    throw new Error(`Checkpoint path is forbidden: ${invalidPath}`);
  }
  return {
    schemaVersion: 2,
    repository: input.claim.repository,
    issueNumber: input.claim.issueNumber,
    claimId: input.claim.claimId,
    custodyEpoch: input.claim.custodyEpoch,
    sourceHostId: input.claim.hostId,
    repositoryHead: input.repositoryHead,
    baseHead: input.baseHead,
    patchDigest: createHash("sha256").update(input.patch).digest("hex"),
    includedUntrackedPaths: [...input.includedUntrackedPaths].sort(),
    validationReceipts: [...input.validationReceipts].sort(),
    createdAt: input.createdAt,
  };
}
