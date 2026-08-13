import * as restate from "@restatedev/restate-sdk";
import type {
  AccountUsageSnapshot,
  AuthorityTask,
  DispatchClaim,
  IssueEvidence,
  IssueRecord,
  QualificationReport,
  RepositoryRef,
} from "../domain/types.js";
import { qualifyIssue } from "../policy/admission.js";
import { decideQuota, type QuotaDecision } from "../policy/quota.js";
import { claimRegistry } from "./claim-registry.js";
import { fakeWorker, type FakeWorkerReceipt } from "./fake-worker.js";
import { schedulerRegistry } from "./scheduler-registry.js";

export interface DryRunInput {
  readonly repository: RepositoryRef;
  readonly issue: IssueRecord;
  readonly evidence: IssueEvidence;
  readonly authorityTask: AuthorityTask;
  readonly claim: DispatchClaim;
  readonly usage: AccountUsageSnapshot;
  readonly now: string;
}

export interface DryRunResult {
  readonly stage: "blocked" | "completed";
  readonly qualification: QualificationReport;
  readonly quota: QuotaDecision;
  readonly conflict?: {
    readonly reason: string;
    readonly conflicts: readonly string[];
  };
  readonly workerReceipt?: FakeWorkerReceipt;
}

interface DryRunState {
  stage: "blocked" | "claimed" | "completed";
  result: DryRunResult;
}

export const dryRunWorkflow = restate.workflow({
  name: "DryRunWorkflow",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext<DryRunState>,
      input: DryRunInput,
    ): Promise<DryRunResult> => {
      const qualification = qualifyIssue({
        repository: input.repository,
        issue: input.issue,
        evidence: input.evidence,
        authorityTask: input.authorityTask,
      });
      const quota = decideQuota({ snapshot: input.usage, now: input.now });
      if (
        !qualification.eligible ||
        (quota.action !== "admit" && quota.action !== "throttle")
      ) {
        const result: DryRunResult = { stage: "blocked", qualification, quota };
        ctx.set("stage", "blocked");
        ctx.set("result", result);
        return result;
      }
      if (
        input.claim.issueNumber !== input.issue.number ||
        input.claim.repository.owner !== input.repository.owner ||
        input.claim.repository.name !== input.repository.name
      ) {
        throw new restate.TerminalError("Dry-run claim does not match its issue.");
      }
      const claimKey = `${input.repository.owner}/${input.repository.name}#${input.issue.number.toLocaleString("en-US", { useGrouping: false })}`;
      const repositoryKey = `${input.repository.owner}/${input.repository.name}`;
      const scheduler = ctx.objectClient(schedulerRegistry, repositoryKey);
      const schedulerResult = await scheduler.acquire({
        claim: input.claim,
        qualification,
        concurrency: "pilot",
      });
      if (!schedulerResult.admitted) {
        const result: DryRunResult = {
          stage: "blocked",
          qualification,
          quota,
          conflict: {
            reason: schedulerResult.decision.reason,
            conflicts: schedulerResult.decision.conflicts,
          },
        };
        ctx.set("stage", "blocked");
        ctx.set("result", result);
        return result;
      }
      const registry = ctx.objectClient(claimRegistry, claimKey);
      try {
        await registry.claim(input.claim);
        ctx.set("stage", "claimed");
        const workerReceipt = await ctx.serviceClient(fakeWorker).run({
          claim: input.claim,
          qualification,
        });
        const result: DryRunResult = {
          stage: "completed",
          qualification,
          quota,
          workerReceipt,
        };
        ctx.set("stage", "completed");
        ctx.set("result", result);
        return result;
      } finally {
        await registry.release({
          claimId: input.claim.claimId,
          custodyEpoch: input.claim.custodyEpoch,
        });
        await scheduler.release({
          claimId: input.claim.claimId,
          custodyEpoch: input.claim.custodyEpoch,
        });
      }
    },
    status: restate.handlers.workflow.shared(
      async (
        ctx: restate.WorkflowSharedContext<DryRunState>,
      ): Promise<{
        readonly stage: "not-started" | "blocked" | "claimed" | "completed";
        readonly result: DryRunResult | null;
      }> => ({
        stage: (await ctx.get("stage")) ?? "not-started",
        result: await ctx.get("result"),
      }),
    ),
  },
});
