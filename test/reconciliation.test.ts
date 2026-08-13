import { describe, expect, it } from "vitest";
import { reconcileClaim } from "../src/policy/reconciliation.js";
import { authorityTask, claim as dispatchClaim } from "./helpers.js";

const issue = {
  number: 1_234,
  url: "https://github.com/freed-project/freed/issues/1234",
  open: true,
  labels: ["debt", "factory:running"],
  openPullRequestBranches: ["fix/deterministic-validation"],
} as const;

describe("reconcileClaim", () => {
  it("continues only when authority, issue, branch, and workspace agree", () => {
    const claim = dispatchClaim();
    expect(
      reconcileClaim({
        claim,
        issue,
        authorityTask: authorityTask(),
        workspaces: [
          {
            hostId: claim.hostId,
            claimId: claim.claimId,
            custodyEpoch: claim.custodyEpoch,
            branch: claim.branch,
            worktree: claim.worktree,
            exists: true,
          },
        ],
      }).action,
    ).toBe("continue");
  });

  it("quarantines a stale workspace after custody transfer", () => {
    const prior = dispatchClaim();
    const claim = { ...prior, custodyEpoch: 2, hostId: "linux-control-1" };
    expect(
      reconcileClaim({
        claim,
        issue,
        authorityTask: authorityTask(),
        workspaces: [
          {
            hostId: claim.hostId,
            claimId: claim.claimId,
            custodyEpoch: claim.custodyEpoch,
            branch: claim.branch,
            worktree: claim.worktree,
            exists: true,
          },
          {
            hostId: prior.hostId,
            claimId: prior.claimId,
            custodyEpoch: prior.custodyEpoch,
            branch: prior.branch,
            worktree: prior.worktree,
            exists: true,
          },
        ],
      }).action,
    ).toBe("quarantine-stale-workspace");
  });

  it("fails closed without canonical authority", () => {
    expect(
      reconcileClaim({
        claim: dispatchClaim(),
        issue,
        workspaces: [],
      }).action,
    ).toBe("block-authority");
  });
});
