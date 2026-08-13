import * as restate from "@restatedev/restate-sdk";
import type { DispatchClaim, HostLane, HostRecord } from "../domain/types.js";
import {
  decideCustody,
  type CustodyDecision,
  validateCheckpointForResume,
} from "../policy/custody.js";
import { claimRegistry } from "./claim-registry.js";
import { schedulerRegistry } from "./scheduler-registry.js";
import { executorCommandRegistry } from "./executor-command-registry.js";
import { hostRegistry } from "./host-registry.js";
import { checkpointCatalog } from "./checkpoint-catalog.js";
import { hostRestoreRegistry } from "./host-restore-registry.js";

function claimMatches(left: DispatchClaim, right: DispatchClaim): boolean {
  return (
    left.repository.owner === right.repository.owner &&
    left.repository.name === right.repository.name &&
    left.repository.defaultBranch === right.repository.defaultBranch &&
    left.issueNumber === right.issueNumber &&
    left.claimId === right.claimId &&
    left.custodyEpoch === right.custodyEpoch &&
    left.hostId === right.hostId &&
    left.workerId === right.workerId &&
    left.branch === right.branch &&
    left.worktree === right.worktree &&
    left.claimedAt === right.claimedAt &&
    JSON.stringify([...left.conflictDomains].sort()) ===
      JSON.stringify([...right.conflictDomains].sort())
  );
}

export interface CustodyTransferInput {
  readonly claim: DispatchClaim;
  readonly sourceHost: HostRecord;
  readonly hosts: readonly HostRecord[];
  readonly requiredLane: HostLane;
  readonly checkpointReference: string;
  readonly destinations: Readonly<
    Record<string, { readonly workerId: string; readonly worktree: string }>
  >;
  readonly now: string;
}

export interface CustodyTransferResult {
  readonly decision: CustodyDecision;
  readonly transferredClaim?: DispatchClaim;
}

interface CustodyTransferState {
  result: CustodyTransferResult;
}

export const custodyTransferWorkflow = restate.workflow({
  name: "CustodyTransferWorkflow",
  options: { ingressPrivate: true },
  handlers: {
    run: async (
      ctx: restate.WorkflowContext<CustodyTransferState>,
      input: CustodyTransferInput,
    ): Promise<CustodyTransferResult> => {
      const claimKey = `${input.claim.repository.owner}/${input.claim.repository.name}#${input.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
      const registry = ctx.objectClient(claimRegistry, claimKey);
      const activeClaim = await registry.read();
      if (activeClaim === null || !claimMatches(activeClaim, input.claim)) {
        throw new restate.TerminalError(
          "Custody transfer input does not match the current claim.",
        );
      }
      if (input.sourceHost.id !== activeClaim.hostId) {
        throw new restate.TerminalError(
          "Custody transfer source does not own the current claim.",
        );
      }
      const hostIds = [
        ...new Set([
          activeClaim.hostId,
          ...input.hosts.map((candidate) => candidate.id),
        ]),
      ];
      const hosts: HostRecord[] = [];
      for (const hostId of hostIds) {
        const host = await ctx.objectClient(hostRegistry, hostId).read({
          now: input.now,
          staleAfterSeconds: 120,
        });
        if (host === null) {
          throw new restate.TerminalError(
            `Custody candidate ${hostId} has no durable heartbeat.`,
          );
        }
        hosts.push(host);
      }
      const sourceHost = hosts.find((host) => host.id === activeClaim.hostId);
      if (sourceHost === undefined) {
        throw new restate.TerminalError(
          "Custody source has no canonical host record.",
        );
      }
      const repositoryKey = `${activeClaim.repository.owner}/${activeClaim.repository.name}`;
      const scheduler = ctx.objectClient(schedulerRegistry, repositoryKey);
      const scheduled = (await scheduler.read()).find(
        (entry) => entry.claim.claimId === activeClaim.claimId,
      );
      if (scheduled === undefined || !claimMatches(scheduled.claim, activeClaim)) {
        throw new restate.TerminalError(
          "Custody transfer does not match the durable scheduler claim.",
        );
      }
      if (input.requiredLane !== scheduled.hostLane) {
        throw new restate.TerminalError(
          "Custody transfer changes the qualified host lane.",
        );
      }
      const decision = decideCustody({
        claim: activeClaim,
        sourceHost,
        hosts,
        requiredLane: scheduled.hostLane,
        now: input.now,
      });
      if (
        decision.action !== "transfer" ||
        decision.destinationHostId === undefined ||
        decision.nextCustodyEpoch === undefined
      ) {
        const result = { decision };
        ctx.set("result", result);
        return result;
      }
      const storedCheckpoint = await ctx
        .objectClient(checkpointCatalog, input.checkpointReference)
        .read();
      if (storedCheckpoint === null) {
        throw new restate.TerminalError(
          "Custody checkpoint has no authenticated storage receipt.",
        );
      }
      const checkpoint = validateCheckpointForResume({
        checkpoint: storedCheckpoint.manifest,
        claim: activeClaim,
        expectedEpoch: decision.nextCustodyEpoch,
      });
      if (!checkpoint.valid) {
        throw new restate.TerminalError(
          `Custody checkpoint cannot resume: ${checkpoint.reason}.`,
        );
      }
      const destination = input.destinations[decision.destinationHostId];
      if (destination === undefined) {
        throw new restate.TerminalError("Selected host has no destination workspace assignment.");
      }
      const transfer = {
        claimId: activeClaim.claimId,
        priorEpoch: activeClaim.custodyEpoch,
        nextEpoch: decision.nextCustodyEpoch,
        destinationHostId: decision.destinationHostId,
        destinationWorkerId: destination.workerId,
        destinationWorktree: destination.worktree,
        transferredAt: input.now,
      };
      const executor = ctx.objectClient(
        executorCommandRegistry,
        activeClaim.hostId,
      );
      await executor.prepareOfflineTransfer({
        claimId: activeClaim.claimId,
        custodyEpoch: activeClaim.custodyEpoch,
        preparedAt: input.now,
        sourceLastHeartbeatAt: sourceHost.lastHeartbeatAt,
        offlineSeconds: decision.offlineSeconds,
      });
      const transferredClaim = await registry.transfer(transfer);
      await scheduler.transfer(transfer);
      await ctx
        .objectClient(hostRestoreRegistry, decision.destinationHostId)
        .require({
          schemaVersion: 1,
          repository: activeClaim.repository,
          issueNumber: activeClaim.issueNumber,
          claimId: activeClaim.claimId,
          priorCustodyEpoch: activeClaim.custodyEpoch,
          custodyEpoch: decision.nextCustodyEpoch,
          destinationHostId: decision.destinationHostId,
          destinationWorkerId: destination.workerId,
          destinationWorktree: destination.worktree,
          branch: activeClaim.branch,
          conflictDomains: [...activeClaim.conflictDomains],
          claimedAt: activeClaim.claimedAt,
          checkpointReference: storedCheckpoint.reference,
          checkpointContentLength: storedCheckpoint.contentLength,
          checkpointBaseHead: storedCheckpoint.manifest.baseHead,
          requiredAt: input.now,
        });
      await executor.releaseTransfer({
        claimId: activeClaim.claimId,
        custodyEpoch: activeClaim.custodyEpoch,
      });
      const result = { decision, transferredClaim };
      ctx.set("result", result);
      return result;
    },
    status: restate.handlers.workflow.shared(
      async (ctx: restate.WorkflowSharedContext<CustodyTransferState>) =>
        await ctx.get("result"),
    ),
  },
});
