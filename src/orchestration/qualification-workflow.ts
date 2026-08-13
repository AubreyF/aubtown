import * as restate from "@restatedev/restate-sdk";
import type {
  AuthorityTask,
  IssueEvidence,
  IssueRecord,
  QualificationReport,
  RepositoryRef,
} from "../domain/types.js";
import { qualifyIssue } from "../policy/admission.js";

interface QualificationWorkflowState {
  report: QualificationReport;
  stage: "blocked" | "qualified";
}

export interface QualificationWorkflowInput {
  readonly repository: RepositoryRef;
  readonly issue: IssueRecord;
  readonly evidence: IssueEvidence;
  readonly authorityTask?: AuthorityTask;
}

export const qualificationWorkflow = restate.workflow({
  name: "QualificationWorkflow",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext<QualificationWorkflowState>,
      input: QualificationWorkflowInput,
    ): Promise<QualificationReport> => {
      const report = qualifyIssue({
        repository: input.repository,
        issue: input.issue,
        evidence: input.evidence,
        ...(input.authorityTask === undefined
          ? {}
          : { authorityTask: input.authorityTask }),
      });
      ctx.set("report", report);
      ctx.set("stage", report.eligible ? "qualified" : "blocked");
      return report;
    },
    status: restate.handlers.workflow.shared(
      async (
        ctx: restate.WorkflowSharedContext<QualificationWorkflowState>,
      ): Promise<{
        readonly stage: "blocked" | "qualified" | "not-started";
        readonly report: QualificationReport | null;
      }> => ({
        stage: (await ctx.get("stage")) ?? "not-started",
        report: await ctx.get("report"),
      }),
    ),
  },
});
