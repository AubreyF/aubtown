import * as restate from "@restatedev/restate-sdk";
import { canonicalJsonEqual } from "../security/canonical-json.js";
import {
  custodyRestoreReceiptSchema,
  custodyRestoreRequirementSchema,
  type CustodyRestoreRequirement,
  type CustodyRestoreReceipt,
  type CustodyRestoreState,
} from "../execution/restore.js";

interface HostRestoreState {
  restore: CustodyRestoreState;
}

export const hostRestoreRegistry = restate.object({
  name: "HostRestoreRegistry",
  options: { ingressPrivate: true },
  handlers: {
    require: async (
      ctx: restate.ObjectContext<HostRestoreState>,
      rawRequirement: CustodyRestoreRequirement,
    ): Promise<CustodyRestoreState> => {
      const requirement = custodyRestoreRequirementSchema.parse(rawRequirement);
      if (requirement.destinationHostId !== ctx.key) {
        throw new restate.TerminalError(
          "Custody restore requirement targets another host.",
        );
      }
      if (requirement.custodyEpoch !== requirement.priorCustodyEpoch + 1) {
        throw new restate.TerminalError(
          "Custody restore requirement must advance exactly one epoch.",
        );
      }
      const current = await ctx.get("restore");
      if (current !== null) {
        if (canonicalJsonEqual(current.requirement, requirement)) {
          return current;
        }
        if (current.stage !== "restored") {
          throw new restate.TerminalError(
            "Destination host already has another custody restore requirement.",
          );
        }
      }
      const next: CustodyRestoreState = { requirement, stage: "pending" };
      ctx.set("restore", next);
      return next;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<HostRestoreState>) =>
        await ctx.get("restore"),
    ),
    record: async (
      ctx: restate.ObjectContext<HostRestoreState>,
      rawReceipt: CustodyRestoreReceipt,
    ): Promise<CustodyRestoreState> => {
      const receipt = custodyRestoreReceiptSchema.parse(rawReceipt);
      const current = await ctx.get("restore");
      if (current === null) {
        throw new restate.TerminalError(
          "Destination host has no custody restore requirement.",
        );
      }
      if (current.stage === "restored") {
        const recorded = current.receipt;
        if (
          recorded === undefined ||
          recorded.claimId !== receipt.claimId ||
          recorded.custodyEpoch !== receipt.custodyEpoch ||
          recorded.destinationHostId !== receipt.destinationHostId ||
          recorded.destinationWorktree !== receipt.destinationWorktree ||
          recorded.checkpointReference !== receipt.checkpointReference ||
          recorded.checkpointBaseHead !== receipt.checkpointBaseHead
        ) {
          throw new restate.TerminalError(
            "Destination host already records another restore receipt.",
          );
        }
        return current;
      }
      const expected = current.requirement;
      if (
        receipt.claimId !== expected.claimId ||
        receipt.custodyEpoch !== expected.custodyEpoch ||
        receipt.destinationHostId !== expected.destinationHostId ||
        receipt.destinationWorktree !== expected.destinationWorktree ||
        receipt.checkpointReference !== expected.checkpointReference ||
        receipt.checkpointBaseHead !== expected.checkpointBaseHead
      ) {
        throw new restate.TerminalError(
          "Custody restore receipt does not match its requirement.",
        );
      }
      const next: CustodyRestoreState = {
        requirement: expected,
        stage: "restored",
        receipt,
      };
      ctx.set("restore", next);
      return next;
    },
    clear: async (
      ctx: restate.ObjectContext<HostRestoreState>,
      expected: { readonly claimId: string; readonly custodyEpoch: number },
    ): Promise<boolean> => {
      const current = await ctx.get("restore");
      if (current === null) {
        return false;
      }
      if (
        current.requirement.claimId !== expected.claimId ||
        current.requirement.custodyEpoch !== expected.custodyEpoch
      ) {
        throw new restate.TerminalError(
          "Only the current custody restore may be cleared.",
        );
      }
      ctx.clear("restore");
      return true;
    },
  },
});
