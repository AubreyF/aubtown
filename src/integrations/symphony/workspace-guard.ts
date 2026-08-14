import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../../adapters/command-runner.js";
import type { WorkerRuntimeConfig } from "../../config/worker-runtime.js";

const forbiddenAuthorship = /(?:codex|symphony|chatgpt|openai|claude|openhands|grok)/iu;
const branchPattern = /^(?:feat|fix|chore|docs|refactor|perf|style)\/[a-z0-9][a-z0-9-]*$/u;

export async function assertPreparedSymphonyWorkspace(input: {
  readonly workspace: string;
  readonly config: WorkerRuntimeConfig;
  readonly runner: CommandRunner;
  readonly requireClean?: boolean;
}): Promise<{
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
}> {
  const workspace = path.resolve(input.workspace);
  const worktreeRoot = await physicalDirectory(input.config.worktreeRoot, "worktree root");
  const repositoryRoot = await physicalDirectory(
    input.config.repositoryRoot,
    "repository root",
  );
  const physicalWorkspace = await physicalDirectory(workspace, "Symphony workspace");
  if (!physicalWorkspace.startsWith(`${worktreeRoot}${path.sep}`)) {
    throw new Error("Symphony workspace escapes the configured worktree root.");
  }
  const topLevel = (
    await input.runner.run({
      executable: input.config.gitExecutable,
      args: ["rev-parse", "--show-toplevel"],
      cwd: physicalWorkspace,
    })
  ).stdout.trim();
  if ((await realpath(topLevel)) !== physicalWorkspace) {
    throw new Error("Symphony workspace is not the root of its Git worktree.");
  }
  const commonDirectory = (
    await input.runner.run({
      executable: input.config.gitExecutable,
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: physicalWorkspace,
    })
  ).stdout.trim();
  if ((await realpath(commonDirectory)) !== (await realpath(path.join(repositoryRoot, ".git")))) {
    throw new Error("Symphony workspace belongs to another Git repository.");
  }
  const branch = (
    await input.runner.run({
      executable: input.config.gitExecutable,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd: physicalWorkspace,
    })
  ).stdout.trim();
  if (!branchPattern.test(branch) || forbiddenAuthorship.test(branch)) {
    throw new Error("Symphony workspace branch violates publication naming policy.");
  }
  const status = (
    await input.runner.run({
      executable: input.config.gitExecutable,
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: physicalWorkspace,
    })
  ).stdout;
  const clean = status.trim() === "";
  if (input.requireClean !== false && !clean) {
    throw new Error("Symphony workspace must be clean before worker launch.");
  }
  const head = (
    await input.runner.run({
      executable: input.config.gitExecutable,
      args: ["rev-parse", "HEAD"],
      cwd: physicalWorkspace,
    })
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error("Symphony workspace HEAD is invalid.");
  }
  return { branch, head, clean };
}

async function physicalDirectory(value: string, purpose: string): Promise<string> {
  const stats = await lstat(value);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${purpose} must be a physical directory.`);
  }
  return await realpath(value);
}
