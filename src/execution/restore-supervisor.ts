import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { CheckpointStore } from "../checkpoints/store.js";
import type { GitCustodyCheckpointService } from "../checkpoints/git-custody.js";
import type { CheckpointTransferClient } from "../clients/checkpoint-transfer.js";
import type { HostGatewayClient } from "../clients/host-gateway.js";
import type { DispatchClaim } from "../domain/types.js";
import type {
  CustodyRestoreReceipt,
  CustodyRestoreRequirement,
} from "./restore.js";

export interface RestoreGateway {
  pollRestore(): ReturnType<HostGatewayClient["pollRestore"]>;
  requestCheckpointGrant: HostGatewayClient["requestCheckpointGrant"];
  reportRestore(input: CustodyRestoreReceipt): ReturnType<HostGatewayClient["reportRestore"]>;
}

export class HostRestoreSupervisor {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
    private readonly worktreeHelper: string,
    private readonly runner: CommandRunner,
    private readonly custody: GitCustodyCheckpointService,
    private readonly localStore: CheckpointStore,
    private readonly transfer: CheckpointTransferClient,
    private readonly gateway: RestoreGateway,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !path.isAbsolute(repositoryRoot) ||
      !path.isAbsolute(worktreeRoot) ||
      !path.isAbsolute(worktreeHelper)
    ) {
      throw new Error(
        "Restore repository, worktree root, and helper paths must be absolute.",
      );
    }
  }

  async reconcile(): Promise<"none" | "restored" | "blocked"> {
    const poll = await this.gateway.pollRestore();
    if (poll.reason === "claim-stale") {
      return "blocked";
    }
    if (poll.requirement === null) {
      return "none";
    }
    const requirement = poll.requirement;
    await this.#ensureWorkspace(requirement);
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

  async #ensureWorkspace(requirement: CustodyRestoreRequirement): Promise<void> {
    const physicalRepository = await realpath(this.repositoryRoot);
    const helperPathStats = await lstat(this.worktreeHelper);
    if (helperPathStats.isSymbolicLink()) {
      throw new Error("Freed worktree helper cannot be a symbolic link.");
    }
    const physicalHelper = await realpath(this.worktreeHelper);
    const helperStats = await lstat(physicalHelper);
    if (
      !helperStats.isFile() ||
      helperStats.isSymbolicLink() ||
      (helperStats.mode & 0o111) === 0 ||
      !physicalHelper.startsWith(`${physicalRepository}${path.sep}`)
    ) {
      throw new Error(
        "Freed worktree helper must be a physical executable inside the repository.",
      );
    }
    const physicalWorktreeRoot = await realpath(this.worktreeRoot);
    const destination = path.resolve(requirement.destinationWorktree);
    const configuredWorktreeRoot = path.resolve(this.worktreeRoot);
    if (!destination.startsWith(`${configuredWorktreeRoot}${path.sep}`)) {
      throw new Error("Destination worktree escapes the configured host root.");
    }
    try {
      const destinationPathStats = await lstat(destination);
      if (destinationPathStats.isSymbolicLink()) {
        throw new Error("Destination worktree cannot be a symbolic link.");
      }
      const physicalDestination = await realpath(destination);
      const stats = await lstat(physicalDestination);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Destination worktree must be a physical directory.");
      }
      if (!physicalDestination.startsWith(`${physicalWorktreeRoot}${path.sep}`)) {
        throw new Error("Destination worktree escapes the configured host root.");
      }
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    await this.runner.run({
      executable: this.worktreeHelper,
      args: [
        destination,
        "-b",
        requirement.branch,
        requirement.checkpointBaseHead,
        "--swarm",
        "--target",
        "shared",
      ],
      cwd: this.repositoryRoot,
      timeoutMs: 120_000,
      maxBufferBytes: 16 * 1_024 * 1_024,
    });
    const createdPathStats = await lstat(destination);
    const physicalDestination = await realpath(destination);
    if (
      !createdPathStats.isDirectory() ||
      createdPathStats.isSymbolicLink() ||
      !physicalDestination.startsWith(`${physicalWorktreeRoot}${path.sep}`)
    ) {
      throw new Error("Created worktree escapes the configured host root.");
    }
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

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}
