import * as restate from "@restatedev/restate-sdk";
import type {
  ActiveDispatch,
  DispatchClaim,
  QualificationReport,
} from "../domain/types.js";
import {
  BOUNDED_CONCURRENCY_POLICY,
  decideConflict,
  PILOT_CONCURRENCY_POLICY,
  type ConflictDecision,
} from "../policy/conflicts.js";

interface SchedulerState {
  active: readonly ActiveDispatch[];
}

export interface SchedulerAcquireResult {
  readonly admitted: boolean;
  readonly decision: ConflictDecision;
  readonly active: readonly ActiveDispatch[];
}

export const schedulerRegistry = restate.object({
  name: "SchedulerRegistry",
  handlers: {
    acquire: async (
      ctx: restate.ObjectContext<SchedulerState>,
      input: {
        readonly claim: DispatchClaim;
        readonly qualification: QualificationReport;
        readonly concurrency: "pilot" | "bounded";
      },
    ): Promise<SchedulerAcquireResult> => {
      if (
        input.claim.issueNumber !== input.qualification.issue.number ||
        input.claim.repository.owner !== input.qualification.repository.owner ||
        input.claim.repository.name !== input.qualification.repository.name
      ) {
        throw new restate.TerminalError("Scheduler claim does not match qualification identity.");
      }
      const claimDomains = [...input.claim.conflictDomains].sort();
      const qualifiedDomains = [...input.qualification.conflictDomains].sort();
      if (JSON.stringify(claimDomains) !== JSON.stringify(qualifiedDomains)) {
        throw new restate.TerminalError("Scheduler claim changes qualified conflict domains.");
      }
      const active = (await ctx.get("active")) ?? [];
      const existing = active.find(
        (entry) => entry.claim.claimId === input.claim.claimId,
      );
      if (existing !== undefined) {
        return {
          admitted: true,
          decision: { allowed: true, reason: "allowed", conflicts: [] },
          active,
        };
      }
      if (
        active.some(
          (entry) => entry.claim.issueNumber === input.claim.issueNumber,
        )
      ) {
        throw new restate.TerminalError("Issue already has a different active claim.");
      }
      const decision = decideConflict({
        candidate: input.qualification,
        activeClaims: active.map((entry) => entry.claim),
        activeLanes: active.map((entry) => entry.workLane),
        policy:
          input.concurrency === "pilot"
            ? PILOT_CONCURRENCY_POLICY
            : BOUNDED_CONCURRENCY_POLICY,
      });
      if (!decision.allowed) {
        return { admitted: false, decision, active };
      }
      const next = [
        ...active,
        { claim: input.claim, workLane: input.qualification.workLane },
      ];
      ctx.set("active", next);
      return { admitted: true, decision, active: next };
    },
    release: async (
      ctx: restate.ObjectContext<SchedulerState>,
      expected: { readonly claimId: string; readonly custodyEpoch: number },
    ): Promise<boolean> => {
      const active = (await ctx.get("active")) ?? [];
      const entry = active.find((candidate) => candidate.claim.claimId === expected.claimId);
      if (entry === undefined) {
        return false;
      }
      if (entry.claim.custodyEpoch !== expected.custodyEpoch) {
        throw new restate.TerminalError("Only the current custody epoch may release a scheduler claim.");
      }
      ctx.set(
        "active",
        active.filter((candidate) => candidate.claim.claimId !== expected.claimId),
      );
      return true;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<SchedulerState>) =>
        (await ctx.get("active")) ?? [],
    ),
  },
});
