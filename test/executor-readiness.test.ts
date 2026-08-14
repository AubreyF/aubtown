import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { probeExecutorReadiness } from "../src/execution/executor-readiness.js";
import type { WorkerRuntimeConfig } from "../src/config/worker-runtime.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();
const gitExecutable = process.env.AUBTOWN_TEST_GIT_EXECUTABLE ?? "/usr/bin/git";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function fixture(): Promise<{
  readonly runtime: WorkerRuntimeConfig;
  readonly preparer: string;
  readonly completer: string;
  readonly completionReader: string;
  readonly adjudicator: string;
  readonly reviewerRuntime: string;
  readonly baseHead: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-executor-readiness-")),
  );
  roots.push(root);
  const repository = path.join(root, "freed");
  const worktreeRoot = path.join(root, "worktrees");
  const handoffRoot = path.join(root, "handoffs");
  const helper = path.join(repository, "scripts", "worktree-add.sh");
  const preparer = path.join(root, "release", "prepare-symphony-workspace.js");
  const completer = path.join(root, "release", "complete-symphony-workspace.js");
  const completionReader = path.join(root, "release", "read-symphony-completion.js");
  const adjudicator = path.join(root, "release", "adjudicate-symphony-completion.js");
  const reviewerRuntime = path.join(root, "reviewer-runtime.json");
  const reviewerHome = path.join(root, "reviewer");
  const reviewerCodexHome = path.join(reviewerHome, "codex");
  await mkdir(path.dirname(helper), { recursive: true });
  await mkdir(worktreeRoot);
  await mkdir(handoffRoot, { mode: 0o700 });
  await mkdir(path.dirname(preparer), { recursive: true });
  await mkdir(reviewerCodexHome, { recursive: true, mode: 0o700 });
  await chmod(reviewerHome, 0o700);
  await chmod(reviewerCodexHome, 0o700);
  await runner.run({
    executable: gitExecutable,
    args: ["init", "-b", "dev", repository],
    cwd: root,
  });
  await runner.run({
    executable: gitExecutable,
    args: ["config", "user.name", "AubTown Test"],
    cwd: repository,
  });
  await runner.run({
    executable: gitExecutable,
    args: ["config", "user.email", "test@example.invalid"],
    cwd: repository,
  });
  await writeFile(path.join(repository, "README.md"), "test\n");
  await runner.run({
    executable: gitExecutable,
    args: ["add", "."],
    cwd: repository,
  });
  await runner.run({
    executable: gitExecutable,
    args: ["commit", "-m", "test"],
    cwd: repository,
  });
  const baseHead = (
    await runner.run({
      executable: gitExecutable,
      args: ["rev-parse", "HEAD"],
      cwd: repository,
    })
  ).stdout.trim();
  await runner.run({
    executable: gitExecutable,
    args: ["update-ref", "refs/remotes/origin/dev", baseHead],
    cwd: repository,
  });
  await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(helper, 0o700);
  await writeFile(preparer, "export {};\n", { mode: 0o600 });
  await writeFile(completer, "export {};\n", { mode: 0o600 });
  await writeFile(completionReader, "export {};\n", { mode: 0o600 });
  await writeFile(adjudicator, "export {};\n", { mode: 0o600 });
  const nodeExecutable = await realpath(process.execPath);
  await writeFile(
    reviewerRuntime,
    `${JSON.stringify({
      schemaVersion: 1,
      hostId: "linux-control-1",
      accountId: "codex-pro-1",
      codexExecutable: nodeExecutable,
      codexHome: reviewerCodexHome,
      homeDirectory: reviewerHome,
      model: "test-model",
      effort: "high",
      quotaSampleIntervalMs: 30_000,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    preparer,
    completer,
    completionReader,
    adjudicator,
    reviewerRuntime,
    baseHead,
    runtime: {
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
      nodeExecutable,
      nodeVersion: process.version,
    },
  };
}

describe("executor readiness", () => {
  it("proves the physical helper, runtimes, writable workspace, and base ref", async () => {
    const prepared = await fixture();
    await expect(
      probeExecutorReadiness({
        runtime: prepared.runtime,
        preparerFile: prepared.preparer,
        completionFile: prepared.completer,
        completionReaderFile: prepared.completionReader,
        adjudicatorFile: prepared.adjudicator,
        reviewerRuntimeFile: prepared.reviewerRuntime,
        runner,
        checkedAt: "2026-08-13T22:00:00.000Z",
        runningNodeExecutable: prepared.runtime.nodeExecutable,
        runningNodeVersion: prepared.runtime.nodeVersion,
      }),
    ).resolves.toMatchObject({
      ready: true,
      hostId: "linux-control-1",
      baseHead: prepared.baseHead,
      node: { version: process.version },
      handoffRoot: prepared.runtime.handoffRoot,
      helper: { path: prepared.runtime.worktreeHelper },
      preparer: { path: prepared.preparer },
      completer: { path: prepared.completer },
      completionReader: { path: prepared.completionReader },
      adjudicator: { path: prepared.adjudicator },
      reviewer: { accountId: "codex-pro-1", model: "test-model" },
    });
  });

  it("rejects an executor handoff root exposed to another OS user", async () => {
    const prepared = await fixture();
    await chmod(prepared.runtime.handoffRoot, 0o755);
    await expect(
      probeExecutorReadiness({
        runtime: prepared.runtime,
        preparerFile: prepared.preparer,
        completionFile: prepared.completer,
        completionReaderFile: prepared.completionReader,
        adjudicatorFile: prepared.adjudicator,
        reviewerRuntimeFile: prepared.reviewerRuntime,
        runner,
        checkedAt: "2026-08-13T22:00:00.000Z",
        runningNodeExecutable: prepared.runtime.nodeExecutable,
        runningNodeVersion: prepared.runtime.nodeVersion,
      }),
    ).rejects.toThrow("must not be accessible to another OS user");
  });

  it("rejects a helper outside the enrolled Freed checkout", async () => {
    const prepared = await fixture();
    const foreign = path.join(
      path.dirname(prepared.preparer),
      "foreign-helper",
    );
    await writeFile(foreign, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(foreign, 0o700);
    await expect(
      probeExecutorReadiness({
        runtime: { ...prepared.runtime, worktreeHelper: foreign },
        preparerFile: prepared.preparer,
        completionFile: prepared.completer,
        completionReaderFile: prepared.completionReader,
        adjudicatorFile: prepared.adjudicator,
        reviewerRuntimeFile: prepared.reviewerRuntime,
        runner,
        checkedAt: "2026-08-13T22:00:00.000Z",
        runningNodeExecutable: prepared.runtime.nodeExecutable,
        runningNodeVersion: prepared.runtime.nodeVersion,
      }),
    ).rejects.toThrow("escapes the repository root");
  });

  it("rejects a different running Node version", async () => {
    const prepared = await fixture();
    await expect(
      probeExecutorReadiness({
        runtime: prepared.runtime,
        preparerFile: prepared.preparer,
        completionFile: prepared.completer,
        completionReaderFile: prepared.completionReader,
        adjudicatorFile: prepared.adjudicator,
        reviewerRuntimeFile: prepared.reviewerRuntime,
        runner,
        checkedAt: "2026-08-13T22:00:00.000Z",
        runningNodeExecutable: prepared.runtime.nodeExecutable,
        runningNodeVersion: "v24.14.0",
      }),
    ).rejects.toThrow("configured Node runtime");
  });
});
