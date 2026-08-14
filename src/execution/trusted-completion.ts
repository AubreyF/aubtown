import type { CommandRunner } from "../adapters/command-runner.js";
import type { WorkerRuntimeConfig } from "../config/worker-runtime.js";
import { createExecutorStartCommand } from "./command.js";
import {
  TrustedCompletionReceiptStore,
  trustedCompletionReceiptSchema,
  type TrustedCompletionReceipt,
} from "./completion-receipt.js";
import { GitExecutionCandidateFinalizer } from "./candidate-finalizer.js";
import { loadAdmittedExecutorCustody } from "../integrations/symphony/executor-custody.js";

export async function completeTrustedSymphonyWorkspace(input: {
  readonly workspace: string;
  readonly runtime: WorkerRuntimeConfig;
  readonly runner: CommandRunner;
  readonly completedAt: string;
}): Promise<TrustedCompletionReceipt> {
  const custody = await loadAdmittedExecutorCustody({
    workspace: input.workspace,
    runtime: input.runtime,
    runner: input.runner,
    stage: "completion",
  });
  const binding = custody.manifest.binding;
  const command = createExecutorStartCommand({
    commandId: binding.handoff.finalizationNonce,
    claim: {
      repository: binding.repository,
      issueNumber: binding.issueNumber,
      claimId: binding.claimId,
      custodyEpoch: binding.custodyEpoch,
      hostId: binding.hostId,
      workerId: binding.workerId,
      branch: binding.branch,
      worktree: binding.worktree,
      conflictDomains: binding.conflictDomains,
      claimedAt: binding.claimedAt,
    },
    qualification: binding.handoff.qualification,
    authorityTaskId: binding.handoff.authorityTaskId,
    accountId: binding.handoff.accountId,
    driverId: binding.handoff.driverId,
    baseHead: binding.baseHead,
    issuedAt: binding.claimedAt,
  });
  const finalized = await new GitExecutionCandidateFinalizer(
    input.runner,
    input.runtime.gitExecutable,
  ).finalize(command, binding.handoff.finalizationNonce);
  const receipt = trustedCompletionReceiptSchema.parse({
    schemaVersion: 1,
    kind: "trusted-candidate-finalized",
    manifestDigest: custody.pointer.manifestDigest,
    repository: binding.repository,
    issueNumber: binding.issueNumber,
    claimId: binding.claimId,
    custodyEpoch: binding.custodyEpoch,
    hostId: binding.hostId,
    workerId: binding.workerId,
    worktree: binding.worktree,
    branch: binding.branch,
    authorityTaskId: binding.handoff.authorityTaskId,
    accountId: binding.handoff.accountId,
    driverId: binding.handoff.driverId,
    baseHead: binding.baseHead,
    head: finalized.head,
    patchDigest: finalized.patchDigest,
    finalizationNonce: binding.handoff.finalizationNonce,
    completedAt: input.completedAt,
  });
  return await new TrustedCompletionReceiptStore(
    input.runtime.handoffRoot,
  ).record(receipt);
}
