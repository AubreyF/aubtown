import type { CheckpointStore } from "../checkpoints/store.js";
import type { GitCustodyCheckpointService } from "../checkpoints/git-custody.js";
import type { CheckpointTransferClient } from "../clients/checkpoint-transfer.js";
import type { HostGatewayClient } from "../clients/host-gateway.js";
import type { DispatchClaim } from "../domain/types.js";
import type {
  CustodyRestoreReceipt,
  CustodyRestoreRequirement,
} from "./restore.js";
import { FreedWorkspaceManager } from "./workspace-manager.js";

export interface RestoreGateway {
  pollRestore(): ReturnType<HostGatewayClient["pollRestore"]>;
  requestCheckpointGrant: HostGatewayClient["requestCheckpointGrant"];
  reportRestore(input: CustodyRestoreReceipt): ReturnType<HostGatewayClient["reportRestore"]>;
}

export class HostRestoreSupervisor {
  constructor(
    private readonly workspace: FreedWorkspaceManager,
    private readonly custody: GitCustodyCheckpointService,
    private readonly localStore: CheckpointStore,
    private readonly transfer: CheckpointTransferClient,
    private readonly gateway: RestoreGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<"none" | "restored" | "blocked"> {
    const poll = await this.gateway.pollRestore();
    if (poll.reason === "claim-stale") {
      return "blocked";
    }
    if (poll.requirement === null) {
      return "none";
    }
    const requirement = poll.requirement;
    await this.workspace.prepare({
      worktree: requirement.destinationWorktree,
      branch: requirement.branch,
      baseHead: requirement.checkpointBaseHead,
      target: "shared",
      requireClean: false,
    });
    const claim = this.#claim(requirement);
    const grant = await this.gateway.requestCheckpointGrant({
      repository: requirement.repository,
      issueNumber: requirement.issueNumber,
      claimId: requirement.claimId,
      custodyEpoch: requirement.custodyEpoch,
      checkpointEpoch: requirement.priorCustodyEpoch,
      operation: "download",
      reference: requirement.checkpointReference,
      contentLength: requirement.checkpointContentLength,
    });
    const payload = await this.transfer.download(grant);
    const storedReference = await this.localStore.put(payload);
    if (storedReference !== requirement.checkpointReference) {
      throw new Error("Downloaded checkpoint changed its content address.");
    }
    try {
      await this.custody.verifyRestored({
        reference: requirement.checkpointReference,
        claim,
        destinationRoot: requirement.destinationWorktree,
      });
    } catch {
      await this.custody.restore({
        reference: requirement.checkpointReference,
        claim,
        destinationRoot: requirement.destinationWorktree,
      });
    }
    await this.gateway.reportRestore({
      schemaVersion: 1,
      claimId: requirement.claimId,
      custodyEpoch: requirement.custodyEpoch,
      destinationHostId: requirement.destinationHostId,
      destinationWorktree: requirement.destinationWorktree,
      checkpointReference: requirement.checkpointReference,
      checkpointBaseHead: requirement.checkpointBaseHead,
      restoredAt: this.now().toISOString(),
    });
    return "restored";
  }

  #claim(requirement: CustodyRestoreRequirement): DispatchClaim {
    return {
      repository: requirement.repository,
      issueNumber: requirement.issueNumber,
      claimId: requirement.claimId,
      custodyEpoch: requirement.custodyEpoch,
      hostId: requirement.destinationHostId,
      workerId: requirement.destinationWorkerId,
      branch: requirement.branch,
      worktree: requirement.destinationWorktree,
      conflictDomains: requirement.conflictDomains,
      claimedAt: requirement.claimedAt,
    };
  }
}
