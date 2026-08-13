import * as restate from "@restatedev/restate-sdk";
import { canonicalJson } from "../security/canonical-json.js";
import {
  initialWorkspaceReceiptSchema,
  initialWorkspaceRequirementSchema,
  type InitialWorkspaceReceipt,
  type InitialWorkspaceRequirement,
  type InitialWorkspaceState,
} from "../execution/workspace.js";

interface HostWorkspaceState {
  workspace: InitialWorkspaceState;
}

export const hostWorkspaceRegistry = restate.object({
  name: "HostWorkspaceRegistry",
  options: { ingressPrivate: true },
  handlers: {
    require: async (
      ctx: restate.ObjectContext<HostWorkspaceState>,
      rawRequirement: InitialWorkspaceRequirement,
    ): Promise<InitialWorkspaceState> => {
      const requirement = initialWorkspaceRequirementSchema.parse(rawRequirement);
      if (requirement.hostId !== ctx.key) {
        throw new restate.TerminalError(
          "Initial workspace requirement targets another host.",
        );
      }
      const current = await ctx.get("workspace");
      if (current !== null) {
        if (canonicalJson(current.requirement) === canonicalJson(requirement)) {
          return current;
        }
        if (current.stage !== "prepared") {
          throw new restate.TerminalError(
            "Host already has another initial workspace requirement.",
          );
        }
      }
      const next: InitialWorkspaceState = { requirement, stage: "pending" };
      ctx.set("workspace", next);
      return next;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<HostWorkspaceState>) =>
        await ctx.get("workspace"),
    ),
    record: async (
      ctx: restate.ObjectContext<HostWorkspaceState>,
      rawReceipt: InitialWorkspaceReceipt,
    ): Promise<InitialWorkspaceState> => {
      const receipt = initialWorkspaceReceiptSchema.parse(rawReceipt);
      const current = await ctx.get("workspace");
      if (current === null) {
        throw new restate.TerminalError(
          "Host has no initial workspace requirement.",
        );
      }
      if (current.stage === "prepared") {
        const recorded = current.receipt;
        if (
          recorded === undefined ||
          recorded.claimId !== receipt.claimId ||
          recorded.custodyEpoch !== receipt.custodyEpoch ||
          recorded.hostId !== receipt.hostId ||
          recorded.worktree !== receipt.worktree ||
          recorded.branch !== receipt.branch ||
          recorded.baseHead !== receipt.baseHead
        ) {
          throw new restate.TerminalError(
            "Host already records another initial workspace receipt.",
          );
        }
        return current;
      }
      const expected = current.requirement;
      if (
        receipt.claimId !== expected.claimId ||
        receipt.hostId !== expected.hostId ||
        receipt.worktree !== expected.worktree ||
        receipt.branch !== expected.branch ||
        receipt.baseHead !== expected.baseHead
      ) {
        throw new restate.TerminalError(
          "Initial workspace receipt does not match its requirement.",
        );
      }
      const next: InitialWorkspaceState = {
        requirement: expected,
        stage: "prepared",
        receipt,
      };
      ctx.set("workspace", next);
      return next;
    },
    clear: async (
      ctx: restate.ObjectContext<HostWorkspaceState>,
      expected: { readonly claimId: string; readonly custodyEpoch: 1 },
    ): Promise<boolean> => {
      const current = await ctx.get("workspace");
      if (current === null) {
        return false;
      }
      if (
        current.requirement.claimId !== expected.claimId ||
        expected.custodyEpoch !== 1
      ) {
        throw new restate.TerminalError(
          "Only the current initial workspace requirement may be cleared.",
        );
      }
      ctx.clear("workspace");
      return true;
    },
  },
});
