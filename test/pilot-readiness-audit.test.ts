import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionAccountProfiles } from "../src/config/account-profiles.js";
import {
  buildStableDispatchIntention,
  type StableDispatchIntentionResult,
} from "../src/orchestration/dispatch-intention.js";
import type { LivePlanningSnapshot } from "../src/orchestration/live-planning-snapshot.js";
import { auditPilotReadiness, type PilotReadinessPaths } from "../src/pilot/readiness.js";
import { authorityTask, issue, report, usage, FREED_REPOSITORY } from "./helpers.js";

const roots: string[] = [];
const commit = "8".repeat(40);
const patchBytes = Buffer.from("reviewed patch\n", "utf8");
const patchDigest = "7f3d3ee9a3afe9dc0b4bdd3c21cc62c0c8c6d05e17e4258a5254d78042986694";
const auditedAt = "2026-08-13T20:00:30.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

async function protectedFile(file: string, value: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, { mode });
  await chmod(file, mode);
}

async function fixture(): Promise<{
  readonly paths: PilotReadinessPaths;
  readonly planning: LivePlanningSnapshot;
  readonly dispatch: Extract<StableDispatchIntentionResult, { readonly status: "ready" }>;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aubtown-readiness-")));
  roots.push(root);
  const releaseRoot = path.join(root, "release");
  const patchFile = path.join(releaseRoot, "upstream/patches/0001-reviewed.patch");
  const symphonyExecutable = path.join(root, "symphony", commit, "symphony");
  const workflowFile = path.join(root, "WORKFLOW.md");
  const claimBrokerExecutable = path.join(root, "bin", "factory-coordinator");
  const brokerConformanceReportFile = path.join(
    root,
    "state",
    "broker-conformance.json",
  );
  const planningSnapshotFile = path.join(root, "state", "planning.json");
  const dispatchIntentionFile = path.join(root, "state", "dispatch.json");
  const lockFile = path.join(releaseRoot, "upstream", "symphony.lock.json");
  const hostEnrollmentsFile = path.join(root, "config", "hosts.json");
  const accountProfilesFile = path.join(root, "config", "accounts.json");
  const hostWorkspaceRootsFile = path.join(root, "config", "workspaces.json");
  const executorReadinessFile = path.join(
    root,
    "state",
    "executor-readiness.json",
  );

  await protectedFile(patchFile, patchBytes.toString("utf8"));
  await protectedFile(path.join(releaseRoot, ".nvmrc"), "24.14.1\n");
  await protectedFile(
    lockFile,
    `${JSON.stringify({
      schemaVersion: 1,
      repository: "https://github.com/openai/symphony.git",
      production: { commit, sourceSha256: "a".repeat(64) },
      patches: [
        {
          path: "upstream/patches/0001-reviewed.patch",
          sha256: patchDigest,
          verifiedAgainst: commit,
        },
      ],
      reviewedCapabilities: [
        "fail-closed-prelaunch-admission-command",
        "fail-closed-active-turn-guard",
      ],
      knownGaps: [],
    })}\n`,
  );
  await protectedFile(
    workflowFile,
    "kind: github\nfactory:ready\nmax_concurrent_agents: 1\nsymphony-prelaunch.js\nsymphony-active-run-guard.js\n",
  );
  await protectedFile(symphonyExecutable, "#!/bin/sh\nexit 0\n", 0o700);
  await protectedFile(claimBrokerExecutable, "#!/bin/sh\nexit 0\n", 0o700);
  await protectedFile(
    brokerConformanceReportFile,
    `${JSON.stringify({
      schemaVersion: 1,
      profile: "conformance-freed-pilot",
      brokerExecutable: claimBrokerExecutable,
      brokerSha256: createHash("sha256")
        .update("#!/bin/sh\nexit 0\n")
        .digest("hex"),
      checkedAt: "2026-08-13T20:00:15.000Z",
      passed: true,
      checks: [
        "broker-integrity",
        "acquire",
        "acquire-replay",
        "changed-operation-replay",
        "show-after-acquire",
        "list-after-acquire",
        "duplicate-acquire",
        "heartbeat-replay",
        "changed-heartbeat-replay",
        "transfer-replay",
        "stale-epoch-fenced",
        "show-after-transfer",
        "list-after-transfer",
        "release-replay",
        "show-after-release",
        "list-after-release",
      ].map((id) => ({ id, passed: true, detail: "verified" })),
      blockers: [],
    })}\n`,
  );
  await protectedFile(path.join(releaseRoot, "dist/cli/symphony-prelaunch.js"), "export {};\n");
  await protectedFile(
    path.join(releaseRoot, "dist/cli/symphony-active-run-guard.js"),
    "export {};\n",
  );
  await protectedFile(
    path.join(releaseRoot, "dist/cli/prepare-symphony-workspace.js"),
    "export {};\n",
  );
  await protectedFile(
    path.join(releaseRoot, "dist/cli/probe-executor-readiness.js"),
    "export {};\n",
  );
  await protectedFile(
    path.join(releaseRoot, "dist/cli/probe-executor-readiness-local.js"),
    "export {};\n",
  );

  const accountProfiles: ExecutionAccountProfiles = {
    "codex-pro-1": {
      driverId: "codex-app-server-v1",
      enabled: true,
      hostIds: ["linux-control-1"],
    },
  };
  const workspaceRoots = {
    "linux-control-1": "/var/lib/aubtown/workspaces",
  };
  await protectedFile(
    hostEnrollmentsFile,
    `${JSON.stringify({
      "linux-control-1": {
        enabled: true,
        lane: "linux",
        accountIds: ["codex-pro-1"],
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      },
    })}\n`,
  );
  await protectedFile(accountProfilesFile, `${JSON.stringify(accountProfiles)}\n`);
  await protectedFile(hostWorkspaceRootsFile, `${JSON.stringify(workspaceRoots)}\n`);

  const issueRecord = issue();
  const authorityRecord = authorityTask({
    state: "approved_for_pr",
    executionAuthority: "pr-only",
  });
  const planning: LivePlanningSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-08-13T20:00:00.000Z",
    repository: FREED_REPOSITORY,
    issueNumber: issueRecord.number,
    github: {
      status: "ok",
      value: {
        observedAt: "2026-08-13T20:00:00.000Z",
        issue: issueRecord,
        baseHead: "a".repeat(40),
        openPullRequests: [],
      },
    },
    authority: {
      status: "ok",
      value: {
        observedAt: "2026-08-13T20:00:00.000Z",
        inspection: {
          task: authorityRecord,
          active: true,
          reason: "matching-active-task",
        },
        activeClaims: [],
        activeLanes: [],
        claimEvidenceComplete: true,
        claimEvidenceReason: "supported-task-claim-list",
      },
    },
    hosts: {
      status: "ok",
      value: {
        schemaVersion: 1,
        revision: 3,
        observedAt: "2026-08-13T20:00:00.000Z",
        hosts: [
          {
            id: "linux-control-1",
            lane: "linux",
            online: true,
            lastHeartbeatAt: "2026-08-13T20:00:00.000Z",
            activeClaims: [],
            accountIds: ["codex-pro-1"],
          },
        ],
        usageByAccountId: {
          "codex-pro-1": usage({ observedAt: "2026-08-13T20:00:00.000Z" }),
        },
      },
    },
    localRepository: {
      status: "ok",
      value: {
        observedAt: "2026-08-13T20:00:00.000Z",
        remoteBaseHead: "a".repeat(40),
        refs: { "origin/dev": "a".repeat(40) },
        worktrees: [
          { worktree: "/srv/freed", head: "a".repeat(40), branch: "dev" },
        ],
      },
    },
    qualification: report(),
    planningSafe: true,
    blockers: [],
  };
  const dispatch = buildStableDispatchIntention({
    snapshot: planning,
    accountProfiles,
    hostWorkspaceRoots: workspaceRoots,
  });
  if (dispatch.status !== "ready") {
    throw new Error(`Readiness fixture dispatch failed: ${dispatch.blockers.join(", ")}.`);
  }
  await protectedFile(planningSnapshotFile, `${JSON.stringify(planning)}\n`);
  await protectedFile(dispatchIntentionFile, `${JSON.stringify(dispatch)}\n`);
  await protectedFile(
    executorReadinessFile,
    `${JSON.stringify({
      schemaVersion: 1,
      hostId: "linux-control-1",
      repository: FREED_REPOSITORY,
      checkedAt: "2026-08-13T20:00:15.000Z",
      ready: true,
      repositoryRoot: "/srv/freed/repository",
      worktreeRoot: "/var/lib/aubtown/workspaces",
      baseHead: "a".repeat(40),
      git: { executable: "/usr/bin/git", version: "git version 2.50.1" },
      node: {
        executable: "/opt/aubtown/node/bin/node",
        version: "v24.14.1",
      },
      helper: {
        path: "/srv/freed/repository/scripts/worktree-add.sh",
        sha256: "b".repeat(64),
      },
      preparer: {
        path: "/opt/aubtown/releases/test/dist/cli/prepare-symphony-workspace.js",
        sha256: createHash("sha256").update("export {};\n").digest("hex"),
      },
    })}\n`,
  );

  return {
    paths: {
      releaseRoot,
      symphonyLockFile: lockFile,
      symphonyExecutable,
      workflowFile,
      claimBrokerExecutable,
      brokerConformanceReportFile,
      planningSnapshotFile,
      dispatchIntentionFile,
      hostEnrollmentsFile,
      accountProfilesFile,
      hostWorkspaceRootsFile,
      executorReadinessFile,
    },
    planning,
    dispatch,
  };
}

describe("pilot readiness audit", () => {
  it("proves one coherent protected runtime and dispatch", async () => {
    const prepared = await fixture();
    const report = await auditPilotReadiness({
      repository: "freed-project/freed",
      issueNumber: 1234,
      auditedAt,
      paths: prepared.paths,
    });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((candidate) => candidate.passed)).toBe(true);
  });

  it("fails closed for stale planning and an absent authority broker", async () => {
    const prepared = await fixture();
    await protectedFile(
      prepared.paths.planningSnapshotFile,
      `${JSON.stringify({ ...prepared.planning, generatedAt: "2026-08-13T19:50:00.000Z" })}\n`,
    );
    await rm(prepared.paths.claimBrokerExecutable);
    const report = await auditPilotReadiness({
      repository: "freed-project/freed",
      issueNumber: 1234,
      auditedAt,
      paths: prepared.paths,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining(["authority:claim-broker", "runtime:planning-snapshot"]),
    );
  });

  it("rejects a dispatch that substitutes another issue", async () => {
    const prepared = await fixture();
    const dispatch = structuredClone(prepared.dispatch) as {
      intention: { candidateInput: { intendedClaim: { issueNumber: number } } };
    };
    dispatch.intention.candidateInput.intendedClaim.issueNumber = 9999;
    await protectedFile(
      prepared.paths.dispatchIntentionFile,
      `${JSON.stringify(dispatch)}\n`,
    );
    const report = await auditPilotReadiness({
      repository: "freed-project/freed",
      issueNumber: 1234,
      auditedAt,
      paths: prepared.paths,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toContain("planning:dispatch-coherence");
  });

  it("rejects a broker changed after its disposable proof", async () => {
    const prepared = await fixture();
    await protectedFile(
      prepared.paths.claimBrokerExecutable,
      "#!/bin/sh\nexit 1\n",
      0o700,
    );
    const report = await auditPilotReadiness({
      repository: "freed-project/freed",
      issueNumber: 1234,
      auditedAt,
      paths: prepared.paths,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain("authority:broker-conformance");
  });

  it("rejects readiness from another executor host", async () => {
    const prepared = await fixture();
    const current = JSON.parse(
      await readFile(prepared.paths.executorReadinessFile, "utf8"),
    ) as Record<string, unknown>;
    await protectedFile(
      prepared.paths.executorReadinessFile,
      `${JSON.stringify({ ...current, hostId: "macos-executor-1" })}\n`,
    );
    const report = await auditPilotReadiness({
      repository: "freed-project/freed",
      issueNumber: 1234,
      auditedAt,
      paths: prepared.paths,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toContain("planning:executor-coherence");
  });
});
