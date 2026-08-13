import * as restate from "@restatedev/restate-sdk";
import type {
  CustodyCheckpoint,
  DispatchClaim,
  HostLane,
  HostRecord,
} from "../domain/types.js";
import {
  decideCustody,
  type CustodyDecision,
  validateCheckpointForResume,
} from "../policy/custody.js";
import { claimRegistry } from "./claim-registry.js";
import { schedulerRegistry } from "./scheduler-registry.js";

export interface CustodyTransferInput {
  readonly claim: DispatchClaim;
  readonly sourceHost: HostRecord;
  readonly hosts: readonly HostRecord[];
  readonly requiredLane: HostLane;
  readonly checkpoint: CustodyCheckpoint;
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
      const decision = decideCustody(input);
      if (
        decision.action !== "transfer" ||
        decision.destinationHostId === undefined ||
        decision.nextCustodyEpoch === undefined
      ) {
        const result = { decision };
        ctx.set("result", result);
        return result;
      }
      const checkpoint = validateCheckpointForResume({
        checkpoint: input.checkpoint,
        claim: input.claim,
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
        claimId: input.claim.claimId,
        priorEpoch: input.claim.custodyEpoch,
        nextEpoch: decision.nextCustodyEpoch,
        destinationHostId: decision.destinationHostId,
        destinationWorkerId: destination.workerId,
        destinationWorktree: destination.worktree,
        transferredAt: input.now,
      };
      const claimKey = `${input.claim.repository.owner}/${input.claim.repository.name}#${input.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
      const repositoryKey = `${input.claim.repository.owner}/${input.claim.repository.name}`;
      const registry = ctx.objectClient(claimRegistry, claimKey);
      const scheduler = ctx.objectClient(schedulerRegistry, repositoryKey);
      const transferredClaim = await registry.transfer(transfer);
      await scheduler.transfer(transfer);
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
