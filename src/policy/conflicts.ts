import type { DispatchClaim, QualificationReport, WorkLane } from "../domain/types.js";

export interface ConcurrencyPolicy {
  readonly maxWorkers: number;
  readonly laneCaps: Readonly<Partial<Record<WorkLane, number>>>;
}

export interface ConflictDecision {
  readonly allowed: boolean;
  readonly reason:
    | "allowed"
    | "global-cap"
    | "lane-cap"
    | "conflict-domain"
    | "unattended-lane-forbidden";
  readonly conflicts: readonly string[];
}

export const PILOT_CONCURRENCY_POLICY: ConcurrencyPolicy = {
  maxWorkers: 1,
  laneCaps: {
    behavioral: 0,
    integration: 0,
    macos: 1,
    "provider-visible": 0,
    release: 0,
    "runtime-neutral": 1,
    sensitive: 0,
  },
};

export const BOUNDED_CONCURRENCY_POLICY: ConcurrencyPolicy = {
  maxWorkers: 2,
  laneCaps: {
    behavioral: 1,
    integration: 1,
    macos: 1,
    "provider-visible": 0,
    release: 0,
    "runtime-neutral": 2,
    sensitive: 0,
  },
};

export function decideConflict(input: {
  readonly candidate: QualificationReport;
  readonly activeClaims: readonly DispatchClaim[];
  readonly activeLanes: readonly WorkLane[];
  readonly policy: ConcurrencyPolicy;
}): ConflictDecision {
  const laneCap = input.policy.laneCaps[input.candidate.workLane] ?? 0;
  if (laneCap === 0) {
    return { allowed: false, reason: "unattended-lane-forbidden", conflicts: [] };
  }
  if (input.activeClaims.length >= input.policy.maxWorkers) {
    return { allowed: false, reason: "global-cap", conflicts: [] };
  }
  const activeInLane = input.activeLanes.filter(
    (lane) => lane === input.candidate.workLane,
  ).length;
  if (activeInLane >= laneCap) {
    return { allowed: false, reason: "lane-cap", conflicts: [] };
  }
  const candidateDomains = new Set(input.candidate.conflictDomains);
  const conflicts = input.activeClaims
    .flatMap((claim) => claim.conflictDomains)
    .filter((domain) => candidateDomains.has(domain));
  if (conflicts.length > 0) {
    return {
      allowed: false,
      reason: "conflict-domain",
      conflicts: [...new Set(conflicts)].sort(),
    };
  }
  return { allowed: true, reason: "allowed", conflicts: [] };
}
