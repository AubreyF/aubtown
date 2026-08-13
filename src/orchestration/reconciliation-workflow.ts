import * as restate from "@restatedev/restate-sdk";
import {
  reconcileSnapshot,
  type ReconciliationReport,
  type ReconciliationSnapshot,
} from "../policy/reconciliation.js";

interface ReconciliationState {
  report: ReconciliationReport;
}

export const reconciliationWorkflow = restate.workflow({
  name: "ReconciliationWorkflow",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext<ReconciliationState>,
      input: ReconciliationSnapshot,
    ): Promise<ReconciliationReport> => {
      const report = reconcileSnapshot(input);
      ctx.set("report", report);
      return report;
    },
    status: restate.handlers.workflow.shared(
      async (ctx: restate.WorkflowSharedContext<ReconciliationState>) =>
        await ctx.get("report"),
    ),
  },
});
