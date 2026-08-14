import { createHash } from "node:crypto";
import path from "node:path";
import type { ExecutionAccountProfiles } from "../config/account-profiles.js";
import type { HostWorkspaceRoots } from "../config/host-workspaces.js";
import type { DispatchClaim, HostRecord } from "../domain/types.js";
import {
  assembleReconciledAdmissionCandidate,
  type ReconciledAdmissionCandidateInput,
} from "./admission-candidate-reconciler.js";
import type { LivePlanningSnapshot } from "./live-planning-snapshot.js";
import { canonicalJson } from "../security/canonical-json.js";
import { decideConflict, PILOT_CONCURRENCY_POLICY } from "../policy/conflicts.js";
import { planExecutionRouteFromState } from "./route-planner.js";

const HOST_HEARTBEAT_MAX_AGE_SECONDS = 120;

export interface StableDispatchIntention {
  readonly schemaVersion: 1;
  readonly intentionId: string;
  readonly sourceDigest: string;
  readonly plannedAt: string;
  readonly candidateInput: ReconciledAdmissionCandidateInput;
}

export type StableDispatchIntentionResult =
  | { readonly status: "ready"; readonly intention: StableDispatchIntention }
  | { readonly status: "blocked"; readonly blockers: readonly string[] };

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJson(left)).equals(canonicalJson(right));
}

function issueSuffix(issueNumber: number): string {
  return issueNumber.toLocaleString("en-US", { useGrouping: false });
}

function deriveTarget(
  ownedPaths: readonly string[] | undefined,
): ReconciledAdmissionCandidateInput["target"] | undefined {
  const targets = new Set<ReconciledAdmissionCandidateInput["target"]>();
  for (const ownedPath of ownedPaths ?? []) {
    const normalized = ownedPath.replace(/^\.\//u, "");
    if (normalized === "website" || normalized.startsWith("website/")) {
      targets.add("website");
    } else if (
      normalized === "packages/desktop" ||
      normalized.startsWith("packages/desktop/")
    ) {
      targets.add("desktop");
    } else if (
      normalized === "packages/pwa" ||
      normalized.startsWith("packages/pwa/")
    ) {
      targets.add("pwa");
    } else {
      targets.add("shared");
    }
  }
  if (targets.size === 0) {
    return "shared";
  }
  if (targets.size > 1) {
    return undefined;
  }
  return [...targets][0];
}

function freshHosts(
  snapshot: LivePlanningSnapshot,
): readonly HostRecord[] {
  if (snapshot.hosts.status !== "ok") {
    return [];
  }
  const nowMs = Date.parse(snapshot.generatedAt);
  return snapshot.hosts.value.hosts.map((host) => {
    const ageSeconds = (nowMs - Date.parse(host.lastHeartbeatAt)) / 1_000;
    return {
      ...host,
      online:
        host.online &&
        Number.isFinite(ageSeconds) &&
        ageSeconds >= 0 &&
        ageSeconds <= HOST_HEARTBEAT_MAX_AGE_SECONDS,
    };
  });
}

export function buildStableDispatchIntention(input: {
  readonly snapshot: LivePlanningSnapshot;
  readonly accountProfiles: ExecutionAccountProfiles;
  readonly hostWorkspaceRoots: HostWorkspaceRoots;
}): StableDispatchIntentionResult {
  const snapshot = input.snapshot;
  const blockers = [...snapshot.blockers];
  if (!snapshot.planningSafe) {
    blockers.push("planning:not-safe");
  }
  if (
    snapshot.github.status !== "ok" ||
    snapshot.authority.status !== "ok" ||
    snapshot.hosts.status !== "ok" ||
    snapshot.localRepository.status !== "ok" ||
    snapshot.qualification === undefined
  ) {
    blockers.push("planning:required-source-unavailable");
  }
  if (blockers.length > 0) {
    return { status: "blocked", blockers: [...new Set(blockers)].sort() };
  }

  const github = snapshot.github.status === "ok" ? snapshot.github.value : undefined;
  const authority =
    snapshot.authority.status === "ok" ? snapshot.authority.value : undefined;
  const hosts = snapshot.hosts.status === "ok" ? snapshot.hosts.value : undefined;
  const local =
    snapshot.localRepository.status === "ok"
      ? snapshot.localRepository.value
      : undefined;
  const qualification = snapshot.qualification;
  const task = authority?.inspection.task;
  if (
    github === undefined ||
    authority === undefined ||
    hosts === undefined ||
    local === undefined ||
    qualification === undefined ||
    task === undefined ||
    !authority.claimEvidenceComplete
  ) {
    return {
      status: "blocked",
      blockers: ["planning:complete-authority-evidence-required"],
    };
  }

  const coherenceBlockers: string[] = [];
  if (
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    snapshot.issueNumber !== github.issue.number ||
    !sameCanonical(snapshot.repository, qualification.repository) ||
    !sameCanonical(github.issue, qualification.issue)
  ) {
    coherenceBlockers.push("planning:issue-identity-mismatch");
  }
  if (
    !authority.inspection.active ||
    task.githubIssue.number !== github.issue.number ||
    task.githubIssue.url !== github.issue.url
  ) {
    coherenceBlockers.push("planning:authority-task-mismatch");
  }
  if (
    authority.activeClaims.length !== authority.activeLanes.length ||
    !qualification.eligible ||
    qualification.checks.some((check) => check.blocking && !check.passed)
  ) {
    coherenceBlockers.push("planning:qualification-or-claim-set-incoherent");
  }
  if (
    local.remoteBaseHead !== github.baseHead ||
    hosts.observedAt === null
  ) {
    coherenceBlockers.push("planning:source-head-or-host-state-incoherent");
  }
  if (coherenceBlockers.length > 0) {
    return {
      status: "blocked",
      blockers: [...new Set(coherenceBlockers)].sort(),
    };
  }

  const target = deriveTarget(qualification.evidence.ownedPaths);
  if (target === undefined) {
    return { status: "blocked", blockers: ["planning:multiple-worktree-targets"] };
  }
  const conflict = decideConflict({
    candidate: qualification,
    activeClaims: authority.activeClaims,
    activeLanes: authority.activeLanes,
    policy: PILOT_CONCURRENCY_POLICY,
  });
  if (!conflict.allowed) {
    return {
      status: "blocked",
      blockers: [`planning:conflict:${conflict.reason}`],
    };
  }

  const eligibleHosts = freshHosts(snapshot);
  const route = planExecutionRouteFromState({
    requiredLane: qualification.hostLane,
    hosts: eligibleHosts,
    profiles: input.accountProfiles,
    usageByAccountId: hosts.usageByAccountId,
    now: snapshot.generatedAt,
  });
  if (route.route === undefined) {
    return {
      status: "blocked",
      blockers: [`planning:route:${route.reason}`],
    };
  }
  const workspaceRoot = input.hostWorkspaceRoots[route.route.hostId];
  if (workspaceRoot === undefined) {
    return {
      status: "blocked",
      blockers: ["planning:selected-host-workspace-root-missing"],
    };
  }

  const suffix = issueSuffix(snapshot.issueNumber);
  const branch = `fix/issue-${suffix}`;
  const worktree = path.join(
    workspaceRoot,
    `GH-${suffix}`,
  );
  const collision =
    github.openPullRequests.some((pull) => pull.branch === branch) ||
    local.refs[branch] !== undefined ||
    local.refs[`origin/${branch}`] !== undefined ||
    local.worktrees.some(
      (candidate) =>
        candidate.branch === branch || candidate.worktree === worktree,
    ) ||
    authority.activeClaims.some(
      (claim) =>
        claim.issueNumber === snapshot.issueNumber ||
        claim.branch === branch ||
        claim.worktree === worktree,
    );
  if (collision) {
    return { status: "blocked", blockers: ["planning:workspace-collision"] };
  }

  const sourceDigest = digest({
    snapshot,
    accountProfiles: input.accountProfiles,
    hostWorkspaceRoots: input.hostWorkspaceRoots,
    target,
    route: route.route,
  });
  const claim: DispatchClaim = {
    repository: snapshot.repository,
    issueNumber: snapshot.issueNumber,
    claimId: `claim-${suffix}-${sourceDigest.slice(0, 24)}`,
    custodyEpoch: 1,
    hostId: route.route.hostId,
    workerId: `worker-${route.route.hostId}`,
    branch,
    worktree,
    conflictDomains: qualification.conflictDomains,
    claimedAt: snapshot.generatedAt,
  };
  const candidateInput: ReconciledAdmissionCandidateInput = {
    qualification,
    authorityTask: task,
    intendedClaim: claim,
    hosts: eligibleHosts,
    accountProfiles: input.accountProfiles,
    usageByAccountId: hosts.usageByAccountId,
    activeClaims: authority.activeClaims,
    activeLanes: authority.activeLanes,
    baseHead: github.baseHead,
    target,
    now: snapshot.generatedAt,
  };
  try {
    assembleReconciledAdmissionCandidate(candidateInput);
  } catch (error) {
    return {
      status: "blocked",
      blockers: [
        `planning:candidate:${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return {
    status: "ready",
    intention: {
      schemaVersion: 1,
      intentionId: `dispatch-${sourceDigest}`,
      sourceDigest,
      plannedAt: snapshot.generatedAt,
      candidateInput,
    },
  };
}
