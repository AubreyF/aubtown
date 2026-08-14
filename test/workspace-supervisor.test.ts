import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { qualificationReportSchema } from "../src/domain/schemas.js";
import { FreedWorkspaceManager } from "../src/execution/workspace-manager.js";
import { HostWorkspaceSupervisor } from "../src/execution/workspace-supervisor.js";
import {
  createWorkspaceFinalizationNonce,
  type InitialWorkspaceRequirement,
} from "../src/execution/workspace.js";
import { report } from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await runner.run({ executable: "git", args, cwd })).stdout.trim();
}

describe("HostWorkspaceSupervisor", () => {
  it("creates and attests the exact clean initial worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-workspace-"));
    roots.push(root);
    const repository = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    const destination = path.join(worktreeRoot, "issue-1234");
    await mkdir(worktreeRoot);
    await runner.run({
      executable: "git",
      args: ["init", "-b", "dev", repository],
      cwd: root,
    });
    await git(repository, ["config", "user.name", "AubTown Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await mkdir(path.join(repository, "scripts"));
    const helper = path.join(repository, "scripts", "worktree-add.sh");
    await writeFile(
      helper,
      '#!/bin/sh\nexec git worktree add "$1" "$2" "$3" "$4"\n',
      { mode: 0o700 },
    );
    await writeFile(path.join(repository, "tracked.txt"), "base\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "base"]);
    const baseHead = await git(repository, ["rev-parse", "HEAD"]);
    const qualification = report({ ownedPaths: ["tracked.txt"] });
    const repositoryIdentity = {
      owner: "freed-project",
      name: "freed",
      defaultBranch: "dev",
    } as const;
    const nonceInput = {
      repository: repositoryIdentity,
      issueNumber: 1_234,
      claimId: "claim-1234",
      custodyEpoch: 1 as const,
      hostId: "linux-control-1",
      workerId: "worker-linux-1",
      worktree: destination,
      branch: "fix/deterministic-validation",
      authorityTaskId: "github-issue-1234",
      authorityTaskRevision: 1,
      accountId: "codex-pro-1",
      driverId: "codex-app-server-v1",
      baseHead,
    };
    const requirement: InitialWorkspaceRequirement = {
      schemaVersion: 1,
      repository: repositoryIdentity,
      issueNumber: 1_234,
      claimId: "claim-1234",
      custodyEpoch: 1,
      hostId: "linux-control-1",
      workerId: "worker-linux-1",
      worktree: destination,
      branch: "fix/deterministic-validation",
      conflictDomains: [...qualification.conflictDomains],
      claimedAt: "2026-08-13T18:00:00.000Z",
      baseHead,
      target: "shared",
      handoff: {
        qualification: qualificationReportSchema.parse(qualification),
        authorityTaskId: nonceInput.authorityTaskId,
        authorityTaskRevision: nonceInput.authorityTaskRevision,
        accountId: nonceInput.accountId,
        driverId: nonceInput.driverId,
        publicationCeiling: "draft-pr",
        finalizationNonce: createWorkspaceFinalizationNonce(nonceInput),
      },
      requiredAt: "2026-08-13T18:00:01.000Z",
    };
    const reports: unknown[] = [];
    const supervisor = new HostWorkspaceSupervisor(
      new FreedWorkspaceManager(repository, worktreeRoot, helper, runner),
      {
        pollWorkspace: async () => ({
          kind: "workspace-poll" as const,
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          requirement,
          reason: "required" as const,
        }),
        reportWorkspace: async (receipt) => {
          reports.push(receipt);
          return {
            kind: "workspace-receipt" as const,
            hostId: "linux-control-1",
            sequence: 2,
            acceptedAt: "2026-08-13T18:00:03.000Z",
            claimId: requirement.claimId,
            custodyEpoch: 1 as const,
            baseHead,
          };
        },
      },
      () => new Date("2026-08-13T18:00:03.000Z"),
    );

    await expect(supervisor.reconcile()).resolves.toBe("prepared");
    await expect(
      readFile(path.join(destination, "tracked.txt"), "utf8"),
    ).resolves.toBe("base\n");
    await expect(git(destination, ["branch", "--show-current"])).resolves.toBe(
      requirement.branch,
    );
    expect(reports).toEqual([
      expect.objectContaining({
        claimId: requirement.claimId,
        worktree: destination,
        baseHead,
      }),
    ]);

    await writeFile(path.join(destination, "unexpected.txt"), "dirty\n");
    await expect(supervisor.reconcile()).rejects.toThrow(
      "must be clean before worker execution",
    );
  });
});
