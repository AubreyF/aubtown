import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandRunner } from "../src/adapters/command-runner.js";
import type { AuthorityTask } from "../src/domain/types.js";
import type { AuthorityBridge } from "../src/adapters/authority.js";
import { FreedClaimBrokerClient } from "../src/adapters/freed/claim-broker.js";
import type { HostObservationSnapshot } from "../src/gateway/host-observation-journal.js";
import {
  LivePlanningSnapshotCollector,
  FreedBrokerPlanningAuthorityReader,
  GitLocalRepositoryPlanningReader,
  type AuthorityPlanningObservation,
  type GitHubPlanningObservation,
  type LocalRepositoryObservation,
} from "../src/orchestration/live-planning-snapshot.js";
import {
  FREED_REPOSITORY,
  authorityTask,
  issue,
  report,
  usage,
} from "./helpers.js";

const now = "2026-08-13T18:00:00.000Z";
const baseHead = "a".repeat(40);
const qualifiedBody = `### Root cause
Validation reads an unordered collection.

### Evidence
A focused test produces two stable orderings.

### Scope and gates
One runtime-neutral tooling module.

### Done when
- Output is sorted deterministically.

### Validation
- npm run test:tooling

### Owned paths
- scripts/lib/validation-order.mjs

### Logical locks
- tooling-validation

### Host lane
linux

### Work lane
runtime-neutral

### Requires owner review
false

### Behavioral
false

### Release or migration risk
false
`;

function github(): GitHubPlanningObservation {
  return {
    observedAt: now,
    issue: issue({ body: qualifiedBody }),
    baseHead,
    openPullRequests: [],
  };
}

function authority(
  task: AuthorityTask = authorityTask(),
): AuthorityPlanningObservation {
  return {
    observedAt: now,
    inspection: { task, active: true, reason: "matching-active-task" },
    activeClaims: [],
    activeLanes: [],
    claimEvidenceComplete: true,
    claimEvidenceReason: "supported-task-claim-list",
  };
}

function hosts(): HostObservationSnapshot {
  return {
    schemaVersion: 1,
    revision: 2,
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
    ],
    usageByAccountId: { "codex-pro-1": usage({ observedAt: now }) },
  };
}

function local(): LocalRepositoryObservation {
  return {
    observedAt: now,
    remoteBaseHead: baseHead,
    refs: { "origin/dev": baseHead },
    worktrees: [
      { worktree: "/srv/freed", head: baseHead, branch: "dev" },
    ],
  };
}

function collector(overrides: {
  readonly github?: GitHubPlanningObservation;
  readonly authority?: AuthorityPlanningObservation;
  readonly hosts?: HostObservationSnapshot;
  readonly local?: LocalRepositoryObservation;
} = {}): LivePlanningSnapshotCollector {
  return new LivePlanningSnapshotCollector(
    { async read() { return overrides.github ?? github(); } },
    { async read() { return overrides.authority ?? authority(); } },
    { async snapshot() { return overrides.hosts ?? hosts(); } },
    { async read() { return overrides.local ?? local(); } },
  );
}

describe("live planning snapshot", () => {
  it("marks one coherent complete read-only snapshot safe for planning", async () => {
    const snapshot = await collector().collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.planningSafe).toBe(true);
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.qualification).toMatchObject({
      eligible: true,
      workLane: "runtime-neutral",
      conflictDomains: [
        "logical:tooling-validation",
        "path:scripts/lib",
      ],
    });
  });

  it("fails closed when active claim evidence is unavailable", async () => {
    const snapshot = await collector({
      authority: {
        ...authority(),
        activeClaims: [],
        activeLanes: [],
        claimEvidenceComplete: false,
        claimEvidenceReason: "task-claim-list-not-installed",
      },
    }).collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.planningSafe).toBe(false);
    expect(snapshot.blockers).toContain(
      "authority:task-claim-list-not-installed",
    );
  });

  it("blocks mismatched GitHub and local origin heads", async () => {
    const snapshot = await collector({
      local: { ...local(), remoteBaseHead: "b".repeat(40) },
    }).collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.blockers).toContain(
      "local-repository:origin-base-does-not-match-github",
    );
  });

  it("blocks a stale compatible host before dispatch planning", async () => {
    const staleHosts = hosts();
    const snapshot = await collector({
      hosts: {
        ...staleHosts,
        hosts: staleHosts.hosts.map((host) => ({
          ...host,
          lastHeartbeatAt: "2026-08-13T17:57:59.000Z",
        })),
      },
    }).collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.blockers).toContain("hosts:no-fresh-compatible-host");
  });

  it("blocks when every compatible account has reached the weekly ceiling", async () => {
    const observation = hosts();
    const snapshot = await collector({
      hosts: {
        ...observation,
        usageByAccountId: {
          "codex-pro-1": usage({
            observedAt: now,
            primary: {
              usedPercent: 80,
              windowDurationMinutes: 10_080,
              resetsAt: "2026-08-18T08:00:00.000Z",
            },
          }),
        },
      },
    }).collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.blockers).toContain("quota:no-compatible-account-headroom");
  });

  it("preserves source failure reasons and does not manufacture qualification", async () => {
    const snapshot = await new LivePlanningSnapshotCollector(
      { async read() { throw new Error("github-unavailable"); } },
      { async read() { throw new Error("should-not-run"); } },
      { async snapshot() { return hosts(); } },
      { async read() { return local(); } },
    ).collect({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      repositoryRoot: "/srv/freed",
      now,
    });
    expect(snapshot.qualification).toBeUndefined();
    expect(snapshot.blockers).toContain("github:github-unavailable");
    expect(snapshot.blockers).toContain(
      "authority:GitHub qualification is unavailable.",
    );
  });
});

describe("local Git planning reader", () => {
  it("uses no shell and records refs plus every physical worktree", async () => {
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = {
      async run(request) {
        requests.push(request);
        if (request.args[0] === "worktree") {
          return {
            stderr: "",
            stdout: `worktree /srv/freed\nHEAD ${baseHead}\nbranch refs/heads/dev\n\nworktree /srv/worktrees/1234\nHEAD ${"b".repeat(40)}\ndetached\n`,
          };
        }
        return {
          stderr: "",
          stdout: `dev\0${baseHead}\norigin/dev\0${baseHead}\n`,
        };
      },
    };
    const observation = await new GitLocalRepositoryPlanningReader(
      runner,
      "/usr/bin/git",
    ).read({
      repositoryRoot: "/srv/freed",
      defaultBranch: "dev",
      now,
    });
    expect(observation.remoteBaseHead).toBe(baseHead);
    expect(observation.worktrees).toEqual([
      { worktree: "/srv/freed", head: baseHead, branch: "dev" },
      {
        worktree: "/srv/worktrees/1234",
        head: "b".repeat(40),
        branch: null,
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.env !== process.env)).toBe(true);
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBe(
      true,
    );
  });
});

describe("Freed broker planning authority reader", () => {
  function bridge(): AuthorityBridge {
    return {
      id: "freed-authority-v1",
      inspect: async () => ({
        task: authorityTask(),
        active: true,
        reason: "matching-active-task",
      }),
      acquire: async () => {
        throw new Error("not used");
      },
      release: async () => {
        throw new Error("not used");
      },
    };
  }

  function brokerRunner(
    issueUrl = "https://github.com/freed-project/freed/issues/987",
    duplicateWorktree = false,
  ): CommandRunner {
    const listedClaim = {
      taskId: "github-issue-987",
      taskRevision: 3,
      bindingDigest: "b".repeat(64),
      claim: {
        claimId: "claim-987-epoch-2",
        githubIssue: { number: 987, url: issueUrl },
        custodyEpoch: 2,
        hostId: "macos-executor-1",
        workerId: "worker-macos-executor-1",
        branch: "fix/issue-987",
        worktree: "/Users/worker/worktrees/freed-issue-987",
        conflictDomains: ["logical:storage"],
        conflictDomainDigest: "c".repeat(64),
        claimedAt: now,
        heartbeatAt: now,
        baseHead,
        accountId: "codex-pro-1",
        driverId: "codex-app-server-v1",
        target: "desktop",
        workLane: "macos",
        publicationCeiling: "draft-pr",
      },
    };
    return {
      async run(request) {
        expect(request.args.slice(0, 2)).toEqual(["task", "claim-list"]);
        expect(request.env).toEqual({});
        return {
          stderr: "",
          stdout: JSON.stringify({
            action: "task.claim-list",
            result: {
              schemaVersion: 1,
              claims: [
                listedClaim,
                ...(duplicateWorktree
                  ? [
                      {
                        ...listedClaim,
                        taskId: "github-issue-988",
                        claim: {
                          ...listedClaim.claim,
                          claimId: "claim-988-epoch-1",
                          githubIssue: {
                            number: 988,
                            url: "https://github.com/freed-project/freed/issues/988",
                          },
                          branch: "fix/issue-988",
                        },
                      },
                    ]
                  : []),
              ],
            },
          }),
        };
      },
    };
  }

  it("projects complete active claims and lane caps from one broker read", async () => {
    const reader = new FreedBrokerPlanningAuthorityReader(
      bridge(),
      new FreedClaimBrokerClient(brokerRunner(), {
        executable: "/opt/freed/bin/factory-coordinator",
        cwd: "/srv/freed",
      }),
    );
    await expect(
      reader.read({ qualification: report(), now }),
    ).resolves.toMatchObject({
      claimEvidenceComplete: true,
      claimEvidenceReason: "supported-broker-claim-list",
      activeClaims: [
        {
          issueNumber: 987,
          claimId: "claim-987-epoch-2",
          custodyEpoch: 2,
          hostId: "macos-executor-1",
          conflictDomains: ["logical:storage"],
        },
      ],
      activeLanes: ["macos"],
    });
  });

  it("rejects a claim projected from another repository", async () => {
    const reader = new FreedBrokerPlanningAuthorityReader(
      bridge(),
      new FreedClaimBrokerClient(
        brokerRunner("https://github.com/another/repository/issues/987"),
        {
          executable: "/opt/freed/bin/factory-coordinator",
          cwd: "/srv/freed",
        },
      ),
    );
    await expect(reader.read({ qualification: report(), now })).rejects.toThrow(
      "outside the configured repository",
    );
  });

  it("rejects duplicate worktree custody in the active claim set", async () => {
    const reader = new FreedBrokerPlanningAuthorityReader(
      bridge(),
      new FreedClaimBrokerClient(brokerRunner(undefined, true), {
        executable: "/opt/freed/bin/factory-coordinator",
        cwd: "/srv/freed",
      }),
    );
    await expect(reader.read({ qualification: report(), now })).rejects.toThrow(
      "duplicate task, claim, issue, branch, or worktree identity",
    );
  });
});
