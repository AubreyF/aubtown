import type { HostGatewayClient } from "../clients/host-gateway.js";
import type { FreedWorkspaceManager } from "./workspace-manager.js";
import type { InitialWorkspaceReceipt } from "./workspace.js";

export interface WorkspaceGateway {
  pollWorkspace(): ReturnType<HostGatewayClient["pollWorkspace"]>;
  reportWorkspace(
    input: InitialWorkspaceReceipt,
  ): ReturnType<HostGatewayClient["reportWorkspace"]>;
}

export class HostWorkspaceSupervisor {
  constructor(
    private readonly manager: FreedWorkspaceManager,
    private readonly gateway: WorkspaceGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<"none" | "prepared" | "blocked"> {
    const poll = await this.gateway.pollWorkspace();
    if (poll.reason === "claim-stale") {
      return "blocked";
    }
    if (poll.requirement === null) {
      return "none";
    }
    const requirement = poll.requirement;
    await this.manager.prepare({
      worktree: requirement.worktree,
      branch: requirement.branch,
      baseHead: requirement.baseHead,
      target: requirement.target,
    });
    await this.gateway.reportWorkspace({
      schemaVersion: 1,
      claimId: requirement.claimId,
      custodyEpoch: 1,
      hostId: requirement.hostId,
      worktree: requirement.worktree,
      branch: requirement.branch,
      baseHead: requirement.baseHead,
      preparedAt: this.now().toISOString(),
    });
    return "prepared";
  }
}
