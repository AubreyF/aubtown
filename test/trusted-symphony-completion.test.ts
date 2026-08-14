import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import type { WorkerRuntimeConfig } from "../src/config/worker-runtime.js";
import { qualificationReportSchema } from "../src/domain/schemas.js";
import { TrustedCompletionReceiptStore } from "../src/execution/completion-receipt.js";
import { TrustedCompletionBundleStore } from "../src/execution/completion-bundle.js";
import { ExecutorHandoffManifestStore } from "../src/execution/handoff-manifest.js";
import { completeTrustedSymphonyWorkspace } from "../src/execution/trusted-completion.js";
import {
  createWorkspaceFinalizationNonce,
  initialWorkspaceRequirementSchema,
} from "../src/execution/workspace.js";
import { loadAdmittedExecutorCustody } from "../src/integrations/symphony/executor-custody.js";
import { report } from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();
const gitExecutable = process.env.AUBTOWN_TEST_GIT_EXECUTABLE ?? "/usr/bin/git";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await runner.run({ executable: gitExecutable, args, cwd, env: {} })
  ).stdout.trim();
}

async function fixture(): Promise<{
  readonly runtime: WorkerRuntimeConfig;
  readonly workspace: string;
  readonly baseHead: string;
  readonly manifestDigest: string;
  readonly finalizationNonce: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(await realpath(os.tmpdir()), "aubtown-completion-")),
  );
  roots.push(root);
  const repository = path.join(root, "freed");
  const worktreeRoot = path.join(root, "worktrees");
  const handoffRoot = path.join(root, "handoffs");
  const workspace = path.join(worktreeRoot, "GH-1234");
  await mkdir(worktreeRoot);
  await mkdir(handoffRoot, { mode: 0o700 });
  await runner.run({
    executable: gitExecutable,
    args: ["init", "-b", "dev", repository],
    cwd: root,
    env: {},
  });
  await git(repository, ["config", "user.name", "AubTown Test"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await mkdir(path.join(repository, "scripts"));
  const helper = path.join(repository, "scripts", "worktree-add.sh");
  await writeFile(helper, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(path.join(repository, "tracked.txt"), "base\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const baseHead = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, [
    "worktree",
    "add",
    "-b",
    "fix/deterministic-validation",
    workspace,
    baseHead,
  ]);
  const runtime: WorkerRuntimeConfig = {
    schemaVersion: 1,
    hostId: "linux-control-1",
    repository: {
      owner: "freed-project",
      name: "freed",
      defaultBranch: "dev",
    },
    repositoryRoot: repository,
    worktreeRoot,
    handoffRoot,
    worktreeHelper: helper,
    gitExecutable: await realpath(gitExecutable),
    nodeExecutable: await realpath(process.execPath),
    nodeVersion: process.version,
  };
  const qualification = qualificationReportSchema.parse(
    report({ ownedPaths: ["tracked.txt"] }),
  );
  const nonceInput = {
    repository: runtime.repository,
    issueNumber: qualification.issue.number,
    claimId: "claim-1234",
    custodyEpoch: 1 as const,
    hostId: runtime.hostId,
    workerId: "worker-linux-control-1",
    worktree: workspace,
    branch: "fix/deterministic-validation",
    authorityTaskId: "github-issue-1234",
    authorityTaskRevision: 1,
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead,
  };
  const finalizationNonce = createWorkspaceFinalizationNonce(nonceInput);
  const requirement = initialWorkspaceRequirementSchema.parse({
    schemaVersion: 1,
    repository: runtime.repository,
    issueNumber: qualification.issue.number,
    claimId: nonceInput.claimId,
    custodyEpoch: 1,
    hostId: runtime.hostId,
    workerId: nonceInput.workerId,
    worktree: workspace,
    branch: nonceInput.branch,
    conflictDomains: qualification.conflictDomains,
    claimedAt: "2026-08-13T18:00:00.000Z",
    baseHead,
    target: "shared",
    handoff: {
      qualification,
      authorityTaskId: nonceInput.authorityTaskId,
      authorityTaskRevision: nonceInput.authorityTaskRevision,
      accountId: nonceInput.accountId,
      driverId: nonceInput.driverId,
      publicationCeiling: "draft-pr",
      finalizationNonce,
    },
    requiredAt: "2026-08-13T18:00:01.000Z",
  });
  const handoff = await new ExecutorHandoffManifestStore(handoffRoot).publish({
    requirement,
    activatedAt: "2026-08-13T18:00:02.000Z",
  });
  return {
    runtime,
    workspace,
    baseHead,
    manifestDigest: handoff.pointer.manifestDigest,
    finalizationNonce,
  };
}

describe("trusted Symphony completion", () => {
  it("finalizes one owned candidate and persists an idempotent exact receipt", async () => {
    const prepared = await fixture();
    await expect(
      loadAdmittedExecutorCustody({
        workspace: prepared.workspace,
        runtime: prepared.runtime,
        runner,
        stage: "before-run",
      }),
    ).resolves.toMatchObject({ head: prepared.baseHead, clean: true });
    await writeFile(path.join(prepared.workspace, "tracked.txt"), "candidate\n");
    const first = await completeTrustedSymphonyWorkspace({
      workspace: prepared.workspace,
      runtime: prepared.runtime,
      runner,
      completedAt: "2026-08-13T18:10:00.000Z",
    });
    const second = await completeTrustedSymphonyWorkspace({
      workspace: prepared.workspace,
      runtime: prepared.runtime,
      runner,
      completedAt: "2026-08-13T18:11:00.000Z",
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      kind: "trusted-candidate-finalized",
      manifestDigest: prepared.manifestDigest,
      baseHead: prepared.baseHead,
      finalizationNonce: prepared.finalizationNonce,
      completedAt: "2026-08-13T18:10:00.000Z",
    });
    expect(first.head).not.toBe(prepared.baseHead);
    await expect(
      new TrustedCompletionBundleStore(prepared.runtime.handoffRoot).load(
        prepared.manifestDigest,
      ),
    ).resolves.toMatchObject({
      manifestDigest: prepared.manifestDigest,
      receipt: { head: first.head, patchDigest: first.patchDigest },
    });
    expect(await git(prepared.workspace, ["status", "--porcelain=v1"])).toBe("");
    expect(
      await git(prepared.workspace, ["show", "-s", "--format=%B", "HEAD"]),
    ).toBe(
      `fix: resolve issue #1234\n\n(AI Generated).\n\nExecution-Receipt: ${prepared.finalizationNonce}`,
    );
    await expect(
      loadAdmittedExecutorCustody({
        workspace: prepared.workspace,
        runtime: prepared.runtime,
        runner,
        stage: "before-run",
      }),
    ).rejects.toThrow("already finalized");
  });

  it("rejects changes outside qualified ownership without writing a receipt", async () => {
    const prepared = await fixture();
    await writeFile(path.join(prepared.workspace, "outside.txt"), "forbidden\n");
    await expect(
      completeTrustedSymphonyWorkspace({
        workspace: prepared.workspace,
        runtime: prepared.runtime,
        runner,
        completedAt: "2026-08-13T18:10:00.000Z",
      }),
    ).rejects.toThrow("outside qualified ownership");
    await expect(
      new TrustedCompletionReceiptStore(prepared.runtime.handoffRoot).load(
        prepared.manifestDigest,
      ),
    ).resolves.toBeNull();
  });
});
