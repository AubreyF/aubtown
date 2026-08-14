import type { TrustedCompletionBundle } from "../execution/completion-bundle.js";
import type { SymphonyActiveTurnRecord } from "../integrations/symphony/active-turn-journal.js";
import {
  workProductIdentitySchema,
  type WorkProductIdentity,
} from "./receipts.js";

export function workProductFromSymphonyCompletion(input: {
  readonly bundle: TrustedCompletionBundle;
  readonly implementation: SymphonyActiveTurnRecord;
}): WorkProductIdentity {
  const bundle = input.bundle;
  const receipt = bundle.receipt;
  const implementation = input.implementation;
  if (
    implementation.manifestDigest !== bundle.manifestDigest ||
    implementation.repository.owner !== receipt.repository.owner ||
    implementation.repository.name !== receipt.repository.name ||
    implementation.repository.defaultBranch !==
      receipt.repository.defaultBranch ||
    implementation.issueNumber !== receipt.issueNumber ||
    implementation.claimId !== receipt.claimId ||
    implementation.custodyEpoch !== receipt.custodyEpoch ||
    implementation.hostId !== receipt.hostId ||
    implementation.workerId !== receipt.workerId ||
    implementation.accountId !== receipt.accountId ||
    implementation.driverId !== receipt.driverId
  ) {
    throw new Error(
      "Symphony implementation identity does not match trusted completion.",
    );
  }
  const implementationAt = Date.parse(implementation.observedAt);
  const completedAt = Date.parse(receipt.completedAt);
  const completionGapMs = completedAt - implementationAt;
  if (
    !Number.isFinite(completionGapMs) ||
    completionGapMs < 0 ||
    completionGapMs > 120_000
  ) {
    throw new Error(
      "Symphony implementation identity is not temporally adjacent to completion.",
    );
  }
  return workProductIdentitySchema.parse({
    schemaVersion: 1,
    repository: receipt.repository,
    issueNumber: receipt.issueNumber,
    claimId: receipt.claimId,
    custodyEpoch: receipt.custodyEpoch,
    hostId: receipt.hostId,
    branch: receipt.branch,
    worktree: receipt.worktree,
    commandId: receipt.finalizationNonce,
    checkpointReference: bundle.completionReference,
    baseHead: receipt.baseHead,
    head: receipt.head,
    patchDigest: receipt.patchDigest,
    implementation: {
      driverId: implementation.driverId,
      threadId: implementation.threadId,
      turnId: implementation.turnId,
    },
  });
}
