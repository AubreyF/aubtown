import { describe, expect, it } from "vitest";
import {
  reconcileClaim,
  reconcileSnapshot,
} from "../src/policy/reconciliation.js";
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

describe("reconcileSnapshot", () => {
  const currentWorkspace = () => {
    const current = dispatchClaim();
    return {
      hostId: current.hostId,
      claimId: current.claimId,
      custodyEpoch: current.custodyEpoch,
      branch: current.branch,
      worktree: current.worktree,
      exists: true,
    };
  };

  it("admits startup only when every canonical witness agrees", () => {
    const result = reconcileSnapshot({
      observedAt: "2026-08-13T18:00:00.000Z",
      now: "2026-08-13T18:00:30.000Z",
      maxAgeSeconds: 120,
      claims: [dispatchClaim()],
      issues: [issue],
      authorityTasks: [authorityTask()],
      workspaces: [currentWorkspace()],
    });
    expect(result.dispatchSafe).toBe(true);
    expect(result.entries[0]?.decision.action).toBe("continue");
  });

  it("blocks duplicate issue claims before dispatch", () => {
    const result = reconcileSnapshot({
      observedAt: "2026-08-13T18:00:00.000Z",
      now: "2026-08-13T18:00:30.000Z",
      maxAgeSeconds: 120,
      claims: [
        dispatchClaim(),
        dispatchClaim({ claimId: "claim-duplicate", branch: "fix/other", worktree: "/tmp/other" }),
      ],
      issues: [issue],
      authorityTasks: [authorityTask()],
      workspaces: [currentWorkspace()],
    });
    expect(result.dispatchSafe).toBe(false);
    expect(result.entries.every((entry) => entry.decision.action === "block-duplicate-claim"))
      .toBe(true);
  });

  it("blocks stale startup evidence", () => {
    const result = reconcileSnapshot({
      observedAt: "2026-08-13T17:00:00.000Z",
      now: "2026-08-13T18:00:30.000Z",
      maxAgeSeconds: 120,
      claims: [dispatchClaim()],
      issues: [issue],
      authorityTasks: [authorityTask()],
      workspaces: [currentWorkspace()],
    });
    expect(result.entries[0]?.decision.action).toBe("block-stale-snapshot");
  });
});
