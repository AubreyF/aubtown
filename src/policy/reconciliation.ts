import type {
  AuthorityTask,
  DispatchClaim,
  ReconciliationIssueState,
  ReconciliationWorkspaceState,
} from "../domain/types.js";

export type ReconciliationAction =
  | "continue"
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
