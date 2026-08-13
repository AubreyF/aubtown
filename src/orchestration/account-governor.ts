import * as restate from "@restatedev/restate-sdk";
import type {
  AccountUsageSnapshot,
  RawAccountUsageObservation,
} from "../domain/types.js";
import {
  decideQuota,
  mergeUsageObservation,
  type QuotaDecision,
} from "../policy/quota.js";

interface AccountGovernorState {
  snapshot: AccountUsageSnapshot;
  decision: QuotaDecision;
}

export const accountGovernor = restate.object({
  name: "AccountGovernor",
  handlers: {
    observe: async (
      ctx: restate.ObjectContext<AccountGovernorState>,
      input: { readonly observation: RawAccountUsageObservation; readonly now: string },
    ): Promise<QuotaDecision> => {
      const current = await ctx.get("snapshot");
      if (
        current !== null &&
        Date.parse(input.observation.observedAt) < Date.parse(current.observedAt)
      ) {
        throw new restate.TerminalError("Quota observation is older than durable state.");
      }
      if (input.observation.accountId !== ctx.key) {
        throw new restate.TerminalError("Quota observation account does not match object key.");
      }
      const snapshot = mergeUsageObservation({
        ...(current === null ? {} : { previous: current }),
        observation: input.observation,
      });
      const decision = decideQuota({
        snapshot,
        now: input.now,
      });
      ctx.set("snapshot", snapshot);
      ctx.set("decision", decision);
      return decision;
    },
    status: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext<AccountGovernorState>,
      ): Promise<{
        readonly snapshot: AccountUsageSnapshot | null;
        readonly decision: QuotaDecision | null;
      }> => ({
        snapshot: await ctx.get("snapshot"),
        decision: await ctx.get("decision"),
      }),
    ),
  },
});
