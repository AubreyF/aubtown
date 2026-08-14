import { describe, expect, it } from "vitest";
import type { ExecutionAccountProfiles } from "../src/config/account-profiles.js";
import type { HostObservationSnapshot } from "../src/gateway/host-observation-journal.js";
import { buildStableDispatchIntention } from "../src/orchestration/dispatch-intention.js";
import type {
  AuthorityPlanningObservation,
  GitHubPlanningObservation,
  LivePlanningSnapshot,
  LocalRepositoryObservation,
} from "../src/orchestration/live-planning-snapshot.js";
import { authorityTask, issue, report, usage, FREED_REPOSITORY } from "./helpers.js";

const now = "2026-08-13T18:00:00.000Z";
const baseHead = "a".repeat(40);
const profiles: ExecutionAccountProfiles = {
  "codex-pro-1": {
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: ["linux-control-1", "macos-executor-1"],
  },
};
const workspaceRoots = {
  "linux-control-1": "/var/lib/aubtown/workspaces",
  "macos-executor-1": "/Users/worker/.aubtown/workspaces",
};

function github(): GitHubPlanningObservation {
  return {
    observedAt: now,
    issue: issue(),
    baseHead,
    openPullRequests: [],
  };
}

function authority(): AuthorityPlanningObservation {
  return {
    observedAt: now,
    inspection: {
      task: authorityTask({
        state: "approved_for_pr",
        executionAuthority: "pr-only",
      }),
      active: true,
      reason: "matching-active-task",
    },
    activeClaims: [],
    activeLanes: [],
    claimEvidenceComplete: true,
    claimEvidenceReason: "supported-task-claim-list",
  };
}

function hosts(): HostObservationSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    observedAt: now,
    hosts: [
      {
        id: "linux-control-1",
        lane: "linux",
        online: true,
        lastHeartbeatAt: now,
        activeClaims: [],
        accountIds: ["codex-pro-1"],
      },
      {
        id: "macos-executor-1",
        lane: "macos",
        online: true,
        lastHeartbeatAt: now,
        activeClaims: [],
        accountIds: ["codex-pro-1"],
      },
    ],
    usageByAccountId: { "codex-pro-1": usage({ observedAt: now }) },
  };
}

function local(): LocalRepositoryObservation {
  return {
    observedAt: now,
    remoteBaseHead: baseHead,
    refs: { "origin/dev": baseHead },
    worktrees: [{ worktree: "/srv/freed", head: baseHead, branch: "dev" }],
  };
}

function snapshot(overrides: Partial<LivePlanningSnapshot> = {}): LivePlanningSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: now,
    repository: FREED_REPOSITORY,
    issueNumber: 1_234,
    github: { status: "ok", value: github() },
    authority: { status: "ok", value: authority() },
    hosts: { status: "ok", value: hosts() },
    localRepository: { status: "ok", value: local() },
    qualification: report(),
    planningSafe: true,
    blockers: [],
    ...overrides,
  };
}

describe("stable dispatch intention", () => {
  it("builds one byte-stable initial claim and reconciler input", () => {
    const input = {
      snapshot: snapshot(),
      accountProfiles: profiles,
      hostWorkspaceRoots: workspaceRoots,
    };
    const first = buildStableDispatchIntention(input);
    const second = buildStableDispatchIntention(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "ready",
      intention: {
        candidateInput: {
          intendedClaim: {
            issueNumber: 1_234,
            custodyEpoch: 1,
            hostId: "linux-control-1",
            branch: "fix/issue-1234",
            worktree: "/var/lib/aubtown/workspaces/freed-issue-1234",
          },
          baseHead,
          target: "shared",
        },
      },
    });
  });

  it("does not turn an unsafe planning report into a claim", () => {
    expect(
      buildStableDispatchIntention({
        snapshot: snapshot({
          planningSafe: false,
          blockers: ["authority:claim-list-unavailable"],
        }),
        accountProfiles: profiles,
        hostWorkspaceRoots: workspaceRoots,
      }),
    ).toEqual({
      status: "blocked",
      blockers: ["authority:claim-list-unavailable", "planning:not-safe"],
    });
  });

  it("recomputes issue and base-head coherence instead of trusting the safe bit", () => {
    expect(
      buildStableDispatchIntention({
        snapshot: snapshot({
          localRepository: {
            status: "ok",
            value: { ...local(), remoteBaseHead: "b".repeat(40) },
          },
        }),
        accountProfiles: profiles,
        hostWorkspaceRoots: workspaceRoots,
      }),
    ).toEqual({
      status: "blocked",
      blockers: ["planning:source-head-or-host-state-incoherent"],
    });
  });

  it("blocks an existing branch, pull request, worktree, or issue claim", () => {
    const base = snapshot();
    const githubValue = github();
    const result = buildStableDispatchIntention({
      snapshot: {
        ...base,
        github: {
          status: "ok",
          value: {
            ...githubValue,
            openPullRequests: [
              {
                number: 77,
                url: "https://github.com/freed-project/freed/pull/77",
                branch: "fix/issue-1234",
                head: "b".repeat(40),
                base: "dev",
                draft: true,
              },
            ],
          },
        },
      },
      accountProfiles: profiles,
      hostWorkspaceRoots: workspaceRoots,
    });
    expect(result).toEqual({
      status: "blocked",
      blockers: ["planning:workspace-collision"],
    });
  });

  it("blocks issues spanning incompatible worktree targets", () => {
    expect(
      buildStableDispatchIntention({
        snapshot: snapshot({
          qualification: report({
            ownedPaths: ["packages/desktop/src/main.ts", "website/src/app.ts"],
          }),
        }),
        accountProfiles: profiles,
        hostWorkspaceRoots: workspaceRoots,
      }),
    ).toEqual({
      status: "blocked",
      blockers: ["planning:multiple-worktree-targets"],
    });
  });

  it("routes a macOS-qualified runtime-neutral issue only to the Mac root", () => {
    const result = buildStableDispatchIntention({
      snapshot: snapshot({
        qualification: report({ hostLane: "macos" }),
      }),
      accountProfiles: profiles,
      hostWorkspaceRoots: workspaceRoots,
    });
    expect(result).toMatchObject({
      status: "ready",
      intention: {
        candidateInput: {
          intendedClaim: {
            hostId: "macos-executor-1",
            worktree: "/Users/worker/.aubtown/workspaces/freed-issue-1234",
          },
        },
      },
    });
  });
});
