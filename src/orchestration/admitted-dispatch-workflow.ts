import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  assertExecutionAdmission,
  type ExecutionAdmission,
} from "../adapters/execution-admission.js";
import type {
  AuthorityTask,
  DispatchClaim,
  QualificationReport,
} from "../domain/types.js";
import {
  createExecutorStartCommand,
  type ExecutorStartCommand,
} from "../execution/command.js";
import { claimRegistry } from "./claim-registry.js";
import { executorCommandRegistry } from "./executor-command-registry.js";
import { hostWorkspaceRegistry } from "./host-workspace-registry.js";
import { routePlannerApi } from "./route-planner.js";
import { schedulerRegistry } from "./scheduler-registry.js";

const baseHeadSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const targetSchema = z.enum(["shared", "desktop", "pwa", "website"]);
const FORBIDDEN_AUTHORSHIP = /\b(?:codex|symphony|openhands|openai|agent)\b/iu;

export interface AdmittedDispatchInput {
  readonly qualification: QualificationReport;
  readonly authorityTask: AuthorityTask;
  readonly admission: ExecutionAdmission;
  readonly claim: DispatchClaim;
  readonly accountId: string;
  readonly baseHead: string;
  readonly target: "shared" | "desktop" | "pwa" | "website";
  readonly commandId: string;
  readonly concurrency: "pilot" | "bounded";
  readonly now: string;
}

export interface AdmittedDispatchResult {
  readonly stage: "blocked" | "dispatched";
  readonly reason:
    | "dispatched"
    | "no-host"
    | "no-account"
    | "telemetry-unavailable"
    | "no-headroom"
    | "route-changed"
    | "conflict";
  readonly command?: ExecutorStartCommand;
  readonly conflicts?: readonly string[];
}

interface AdmittedDispatchState {
  result: AdmittedDispatchResult;
}

export const admittedDispatchWorkflow = restate.workflow({
  name: "AdmittedDispatchWorkflow",
  options: { ingressPrivate: true },
  handlers: {
    run: async (
      ctx: restate.WorkflowContext<AdmittedDispatchState>,
      input: AdmittedDispatchInput,
    ): Promise<AdmittedDispatchResult> => {
      if (!input.qualification.eligible) {
        throw new restate.TerminalError(
          "An ineligible qualification cannot be dispatched.",
        );
      }
      if (
        input.authorityTask.state === "closed" ||
        input.authorityTask.githubIssue.number !== input.qualification.issue.number ||
        input.authorityTask.githubIssue.url !== input.qualification.issue.url
      ) {
        throw new restate.TerminalError(
          "Dispatch authority task does not match the qualified issue.",
        );
      }
      if (
        input.claim.repository.owner !== input.qualification.repository.owner ||
        input.claim.repository.name !== input.qualification.repository.name ||
        input.claim.repository.defaultBranch !==
          input.qualification.repository.defaultBranch ||
        input.claim.issueNumber !== input.qualification.issue.number ||
        input.claim.custodyEpoch !== 1 ||
        input.claim.claimedAt !== input.now
      ) {
        throw new restate.TerminalError(
          "Initial dispatch claim does not match the qualified issue and epoch.",
        );
      }
      if (FORBIDDEN_AUTHORSHIP.test(input.claim.branch)) {
        throw new restate.TerminalError(
          "Dispatch branch contains a forbidden authorship giveaway.",
        );
      }
      const baseHead = baseHeadSchema.parse(input.baseHead);
      const target = targetSchema.parse(input.target);
      try {
        assertExecutionAdmission({
          admission: input.admission,
          binding: {
            qualification: input.qualification,
            authorityTask: input.authorityTask,
            claim: input.claim,
            accountId: input.accountId,
            baseHead,
            target,
          },
          now: input.now,
        });
      } catch (error) {
        throw new restate.TerminalError(
          error instanceof Error
            ? error.message
            : "Execution authority admission is invalid.",
        );
      }
      const route = await ctx.serviceClient(routePlannerApi).plan({
        requiredLane: input.qualification.hostLane,
        now: input.now,
      });
      if (route.route === undefined) {
        if (route.reason === "selected") {
          throw new restate.TerminalError(
            "Route planner selected no concrete execution route.",
          );
        }
        const result: AdmittedDispatchResult = {
          stage: "blocked",
          reason: route.reason,
        };
        ctx.set("result", result);
        return result;
      }
      if (
        route.route.hostId !== input.claim.hostId ||
        route.route.accountId !== input.accountId
      ) {
        const result: AdmittedDispatchResult = {
          stage: "blocked",
          reason: "route-changed",
        };
        ctx.set("result", result);
        return result;
      }
      const repositoryKey = `${input.claim.repository.owner}/${input.claim.repository.name}`;
      const claimKey = `${repositoryKey}#${input.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
      const scheduler = ctx.objectClient(schedulerRegistry, repositoryKey);
      const scheduled = await scheduler.acquire({
        claim: input.claim,
        qualification: input.qualification,
        concurrency: input.concurrency,
      });
      if (!scheduled.admitted) {
        const result: AdmittedDispatchResult = {
          stage: "blocked",
          reason: "conflict",
          conflicts: scheduled.decision.conflicts,
        };
        ctx.set("result", result);
        return result;
      }
      const claim = ctx.objectClient(claimRegistry, claimKey);
      const workspace = ctx.objectClient(
        hostWorkspaceRegistry,
        input.claim.hostId,
      );
      let claimCreated = false;
      let workspaceRequired = false;
      try {
        await claim.claim(input.claim);
        claimCreated = true;
        await workspace.require({
          schemaVersion: 1,
          repository: input.claim.repository,
          issueNumber: input.claim.issueNumber,
          claimId: input.claim.claimId,
          custodyEpoch: 1,
          hostId: input.claim.hostId,
          workerId: input.claim.workerId,
          worktree: input.claim.worktree,
          branch: input.claim.branch,
          conflictDomains: [...input.claim.conflictDomains],
          claimedAt: input.claim.claimedAt,
          baseHead,
          target,
          requiredAt: input.now,
        });
        workspaceRequired = true;
        const command = createExecutorStartCommand({
          commandId: input.commandId,
          claim: input.claim,
          qualification: input.qualification,
          authorityTaskId: input.authorityTask.id,
          accountId: input.accountId,
          issuedAt: input.now,
        });
        await ctx
          .objectClient(executorCommandRegistry, input.claim.hostId)
          .enqueue(command);
        const result: AdmittedDispatchResult = {
          stage: "dispatched",
          reason: "dispatched",
          command,
        };
        ctx.set("result", result);
        return result;
      } catch (error) {
        if (workspaceRequired) {
          await workspace.clear({
            claimId: input.claim.claimId,
            custodyEpoch: 1,
          });
        }
        if (claimCreated) {
          await claim.release({
            claimId: input.claim.claimId,
            custodyEpoch: 1,
          });
        }
        await scheduler.release({
          claimId: input.claim.claimId,
          custodyEpoch: 1,
        });
        throw error;
      }
    },
    status: restate.handlers.workflow.shared(
      async (ctx: restate.WorkflowSharedContext<AdmittedDispatchState>) =>
        await ctx.get("result"),
    ),
  },
});
