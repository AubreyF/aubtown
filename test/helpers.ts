import type {
  AccountUsageSnapshot,
  AuthorityTask,
  DispatchClaim,
  IssueEvidence,
  IssueRecord,
  QualificationReport,
  RepositoryRef,
} from "../src/domain/types.js";
import { qualifyIssue } from "../src/policy/admission.js";

export const FREED_REPOSITORY: RepositoryRef = {
  owner: "freed-project",
  name: "freed",
  defaultBranch: "dev",
};

export function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 1_234,
    url: "https://github.com/freed-project/freed/issues/1234",
    title: "Make validation deterministic",
    body: "",
    labels: ["debt", "factory:ready"],
    assignees: [],
    state: "open",
    updatedAt: "2026-08-13T08:00:00.000Z",
    ...overrides,
  };
}

export function evidence(overrides: Partial<IssueEvidence> = {}): IssueEvidence {
  return {
    rootCause: "Validation reads an unordered collection.",
    evidence: "A focused test produces two stable orderings.",
    scope: "One runtime-neutral tooling module.",
    acceptanceCriteria: ["The output is sorted deterministically."],
    validation: ["Run the focused tooling test."],
    ownedPaths: ["scripts/lib/validation-order.mjs"],
    logicalLocks: ["tooling-validation"],
    hostLane: "linux",
    lane: "runtime-neutral",
    behavioral: false,
    requiresOwnerReview: false,
    releaseOrMigrationRisk: false,
    ...overrides,
  };
}

export function report(overrides: Partial<IssueEvidence> = {}): QualificationReport {
  return qualifyIssue({
    repository: FREED_REPOSITORY,
    issue: issue(),
    evidence: evidence(overrides),
    authorityTask: {
      id: "github-issue-1234",
      revision: 1,
      state: "triaged",
      githubIssue: {
        number: 1_234,
        url: "https://github.com/freed-project/freed/issues/1234",
      },
      executionAuthority: "merge-safe",
      providerAuthority: "forbidden",
      behavioral: false,
      estimatedMinutes: 20,
    },
  });
}

export function claim(overrides: Partial<DispatchClaim> = {}): DispatchClaim {
  return {
    repository: FREED_REPOSITORY,
    issueNumber: 1_234,
    claimId: "claim-1234",
    custodyEpoch: 1,
    hostId: "linux-control-1",
    workerId: "worker-1",
    branch: "fix/deterministic-validation",
    worktree: "/srv/aubtown/worktrees/freed/1234",
    conflictDomains: ["logical:tooling-validation", "path:scripts/lib"],
    claimedAt: "2026-08-13T08:00:00.000Z",
    ...overrides,
  };
}

export function authorityTask(overrides: Partial<AuthorityTask> = {}): AuthorityTask {
  return {
    id: "github-issue-1234",
    revision: 1,
    state: "triaged",
    githubIssue: {
      number: 1_234,
      url: "https://github.com/freed-project/freed/issues/1234",
    },
    executionAuthority: "merge-safe",
    providerAuthority: "forbidden",
    behavioral: false,
    estimatedMinutes: 20,
    ...overrides,
  };
}

export function usage(
  overrides: Partial<AccountUsageSnapshot> = {},
): AccountUsageSnapshot {
  return {
    accountId: "codex-pro-1",
    observedAt: "2026-08-13T08:00:00.000Z",
    primary: {
      usedPercent: 40,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    dailyBaseline: {
      observedAt: "2026-08-13T07:00:00.000Z",
      usedPercent: 35,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    activeTurnIds: [],
    ...overrides,
  };
}
