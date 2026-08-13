import type {
  AuthorityTask,
  DispatchClaim,
  ReconciliationIssueState,
  ReconciliationWorkspaceState,
} from "../domain/types.js";

export type ReconciliationAction =
  | "continue"
  | "block-stale-snapshot"
  | "block-duplicate-claim"
  | "block-resource-collision"
  | "block-issue-mismatch"
  | "block-authority"
  | "block-label"
  | "block-issue-closed"
  | "quarantine-stale-workspace"
  | "block-missing-workspace"
  | "block-branch-conflict";

export interface ReconciliationDecision {
  readonly action: ReconciliationAction;
  readonly reason: string;
}

export function reconcileClaim(input: {
  readonly claim: DispatchClaim;
  readonly issue?: ReconciliationIssueState;
  readonly authorityTask?: AuthorityTask;
  readonly workspaces: readonly ReconciliationWorkspaceState[];
}): ReconciliationDecision {
  if (input.issue !== undefined && input.issue.number !== input.claim.issueNumber) {
    return { action: "block-issue-mismatch", reason: "issue does not match claim identity" };
  }
  if (input.issue === undefined || !input.issue.open) {
    return { action: "block-issue-closed", reason: "canonical issue is not open" };
  }
  if (!input.issue.labels.includes("factory:running")) {
    return { action: "block-label", reason: "issue does not project an active factory claim" };
  }
  if (
    input.authorityTask === undefined ||
    input.authorityTask.githubIssue.number !== input.claim.issueNumber ||
    input.authorityTask.githubIssue.url !== input.issue.url
  ) {
    return { action: "block-authority", reason: "matching active authority task is absent" };
  }
  const currentWorkspace = input.workspaces.find(
    (workspace) =>
      workspace.claimId === input.claim.claimId &&
      workspace.custodyEpoch === input.claim.custodyEpoch &&
      workspace.hostId === input.claim.hostId,
  );
  if (currentWorkspace === undefined || !currentWorkspace.exists) {
    return { action: "block-missing-workspace", reason: "current custody workspace is absent" };
  }
  const staleWorkspace = input.workspaces.find(
    (workspace) =>
      workspace.claimId === input.claim.claimId &&
      workspace.exists &&
      workspace.custodyEpoch < input.claim.custodyEpoch,
  );
  if (staleWorkspace !== undefined) {
    return {
      action: "quarantine-stale-workspace",
      reason: `stale custody epoch remains on host ${staleWorkspace.hostId}`,
    };
  }
  if (
    input.issue.openPullRequestBranches.some(
      (branch) => branch !== input.claim.branch,
    )
  ) {
    return {
      action: "block-branch-conflict",
      reason: "a different open pull request branch already claims this issue",
    };
  }
  return { action: "continue", reason: "canonical and projected state agree" };
}

export interface ReconciliationSnapshot {
  readonly observedAt: string;
  readonly now: string;
  readonly maxAgeSeconds: number;
  readonly claims: readonly DispatchClaim[];
  readonly issues: readonly ReconciliationIssueState[];
  readonly authorityTasks: readonly AuthorityTask[];
  readonly workspaces: readonly ReconciliationWorkspaceState[];
}

export interface ReconciliationEntry {
  readonly claimId: string;
  readonly issueNumber: number;
  readonly decision: ReconciliationDecision;
}

export interface ReconciliationReport {
  readonly dispatchSafe: boolean;
  readonly observedAt: string;
  readonly entries: readonly ReconciliationEntry[];
}

export function reconcileSnapshot(
  snapshot: ReconciliationSnapshot,
): ReconciliationReport {
  const ageSeconds =
    (Date.parse(snapshot.now) - Date.parse(snapshot.observedAt)) / 1_000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > snapshot.maxAgeSeconds
  ) {
    const entries = snapshot.claims.map((claim) => ({
      claimId: claim.claimId,
      issueNumber: claim.issueNumber,
      decision: {
        action: "block-stale-snapshot" as const,
        reason: "startup evidence is stale or temporally invalid",
      },
    }));
    return { dispatchSafe: false, observedAt: snapshot.observedAt, entries };
  }

  const entries = snapshot.claims.map((claim): ReconciliationEntry => {
    const duplicateIssue = snapshot.claims.some(
      (candidate) =>
        candidate.claimId !== claim.claimId &&
        candidate.repository.owner === claim.repository.owner &&
        candidate.repository.name === claim.repository.name &&
        candidate.issueNumber === claim.issueNumber,
    );
    if (duplicateIssue) {
      return {
        claimId: claim.claimId,
        issueNumber: claim.issueNumber,
        decision: {
          action: "block-duplicate-claim",
          reason: "multiple active claims target one canonical issue",
        },
      };
    }
    const resourceCollision = snapshot.claims.some(
      (candidate) =>
        candidate.claimId !== claim.claimId &&
        (candidate.branch === claim.branch || candidate.worktree === claim.worktree),
    );
    if (resourceCollision) {
      return {
        claimId: claim.claimId,
        issueNumber: claim.issueNumber,
        decision: {
          action: "block-resource-collision",
          reason: "another claim shares this branch or worktree",
        },
      };
    }
    const issue = snapshot.issues.find(
      (candidate) => candidate.number === claim.issueNumber,
    );
    const authorityTask = snapshot.authorityTasks.find(
      (task) =>
        task.githubIssue.number === claim.issueNumber &&
        task.githubIssue.url === issue?.url,
    );
    return {
      claimId: claim.claimId,
      issueNumber: claim.issueNumber,
      decision: reconcileClaim({
        claim,
        ...(issue === undefined ? {} : { issue }),
        ...(authorityTask === undefined ? {} : { authorityTask }),
        workspaces: snapshot.workspaces.filter(
          (workspace) => workspace.claimId === claim.claimId,
        ),
      }),
    };
  });
  return {
    dispatchSafe: entries.every((entry) => entry.decision.action === "continue"),
    observedAt: snapshot.observedAt,
    entries,
  };
}
