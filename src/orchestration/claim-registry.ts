import * as restate from "@restatedev/restate-sdk";
import type {
  ClaimTransferRequest,
  DispatchClaim,
} from "../domain/types.js";

interface ClaimState {
  claim: DispatchClaim;
}

export const claimRegistry = restate.object({
  name: "ClaimRegistry",
  handlers: {
    claim: async (
      ctx: restate.ObjectContext<ClaimState>,
      requested: DispatchClaim,
    ): Promise<DispatchClaim> => {
      const active = await ctx.get("claim");
      if (active !== null && active.claimId !== requested.claimId) {
        throw new restate.TerminalError("Issue already has an active claim.");
      }
      if (active !== null && active.custodyEpoch !== requested.custodyEpoch) {
        throw new restate.TerminalError("Claim custody epoch does not match.");
      }
      ctx.set("claim", requested);
      return requested;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<ClaimState>): Promise<DispatchClaim | null> =>
        await ctx.get("claim"),
    ),
    release: async (
      ctx: restate.ObjectContext<ClaimState>,
      expected: { readonly claimId: string; readonly custodyEpoch: number },
    ): Promise<boolean> => {
      const active = await ctx.get("claim");
      if (active === null) {
        return false;
      }
      if (
        active.claimId !== expected.claimId ||
        active.custodyEpoch !== expected.custodyEpoch
      ) {
        throw new restate.TerminalError("Only the current custody owner may release a claim.");
      }
      ctx.clear("claim");
      return true;
    },
    transfer: async (
      ctx: restate.ObjectContext<ClaimState>,
      request: ClaimTransferRequest,
    ): Promise<DispatchClaim> => {
      const active = await ctx.get("claim");
      if (active === null || active.claimId !== request.claimId) {
        throw new restate.TerminalError("Active claim not found for custody transfer.");
      }
      if (
        active.custodyEpoch === request.nextEpoch &&
        active.hostId === request.destinationHostId &&
        active.workerId === request.destinationWorkerId &&
        active.worktree === request.destinationWorktree
      ) {
        return active;
      }
      if (
        active.custodyEpoch !== request.priorEpoch ||
        request.nextEpoch !== request.priorEpoch + 1
      ) {
        throw new restate.TerminalError("Custody transfer must advance exactly one epoch.");
      }
      const transferred: DispatchClaim = {
        ...active,
        custodyEpoch: request.nextEpoch,
        hostId: request.destinationHostId,
        workerId: request.destinationWorkerId,
        worktree: request.destinationWorktree,
        claimedAt: request.transferredAt,
      };
      ctx.set("claim", transferred);
      return transferred;
    },
  },
});
