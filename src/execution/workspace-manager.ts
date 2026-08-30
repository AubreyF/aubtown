import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";

export interface WorkspacePreparation {
  readonly worktree: string;
  readonly branch: string;
  readonly baseHead: string;
  readonly target: string;
  readonly requireClean?: boolean;
}

export class FreedWorkspaceManager {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
    private readonly worktreeHelper: string,
    private readonly runner: CommandRunner,
    private readonly gitExecutable = "git",
    private readonly nodeExecutable = process.execPath,
  ) {
    if (
      !path.isAbsolute(repositoryRoot) ||
      !path.isAbsolute(worktreeRoot) ||
      !path.isAbsolute(worktreeHelper)
    ) {
      throw new Error(
        "Workspace repository, worktree root, and helper paths must be absolute.",
      );
    }
  }

  async prepare(input: WorkspacePreparation): Promise<void> {
    const repositoryStats = await lstat(this.repositoryRoot);
    if (!repositoryStats.isDirectory() || repositoryStats.isSymbolicLink()) {
      throw new Error("Freed repository root must be a physical directory.");
    }
    const physicalRepository = await realpath(this.repositoryRoot);
    const helperPathStats = await lstat(this.worktreeHelper);
    if (helperPathStats.isSymbolicLink()) {
      throw new Error("Freed worktree helper cannot be a symbolic link.");
    }
    const physicalHelper = await realpath(this.worktreeHelper);
    const helperStats = await lstat(physicalHelper);
    if (
      !helperStats.isFile() ||
      helperStats.isSymbolicLink() ||
      (helperStats.mode & 0o111) === 0 ||
      !physicalHelper.startsWith(`${physicalRepository}${path.sep}`)
    ) {
      throw new Error(
        "Freed worktree helper must be a physical executable inside the repository.",
      );
    }
    const worktreeRootStats = await lstat(this.worktreeRoot);
    if (!worktreeRootStats.isDirectory() || worktreeRootStats.isSymbolicLink()) {
      throw new Error("Freed worktree root must be a physical directory.");
    }
    const physicalWorktreeRoot = await realpath(this.worktreeRoot);
    const destination = path.resolve(input.worktree);
    const configuredWorktreeRoot = path.resolve(this.worktreeRoot);
    if (!destination.startsWith(`${configuredWorktreeRoot}${path.sep}`)) {
      throw new Error("Destination worktree escapes the configured host root.");
    }
    try {
      const destinationStats = await lstat(destination);
      if (destinationStats.isSymbolicLink()) {
        throw new Error("Destination worktree cannot be a symbolic link.");
      }
      const physicalDestination = await realpath(destination);
      if (
        !destinationStats.isDirectory() ||
        !physicalDestination.startsWith(`${physicalWorktreeRoot}${path.sep}`)
      ) {
        throw new Error("Destination worktree escapes the configured host root.");
      }
      await this.#verifyExisting(destination, input);
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    await this.runner.run({
      executable: physicalHelper,
      args: [
        destination,
        "-b",
        input.branch,
        input.baseHead,
        "--install",
        "full",
        "--target",
        input.target,
      ],
      cwd: physicalRepository,
      env: {
        LANG: "C.UTF-8",
        NODE_BIN: this.nodeExecutable,
        PATH: [
          path.dirname(this.nodeExecutable),
          ...(path.isAbsolute(this.gitExecutable)
            ? [path.dirname(this.gitExecutable)]
            : []),
          "/usr/bin",
          "/bin",
        ]
          .filter((entry, index, entries) => entries.indexOf(entry) === index)
          .join(":"),
      },
      timeoutMs: 120_000,
      maxBufferBytes: 16 * 1_024 * 1_024,
    });
    const createdStats = await lstat(destination);
    const physicalDestination = await realpath(destination);
    if (
      !createdStats.isDirectory() ||
      createdStats.isSymbolicLink() ||
      !physicalDestination.startsWith(`${physicalWorktreeRoot}${path.sep}`)
    ) {
      throw new Error("Created worktree escapes the configured host root.");
    }
    await this.#verifyExisting(destination, input);
  }

  async #verifyExisting(
    destination: string,
    input: WorkspacePreparation,
  ): Promise<void> {
    const branch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: destination,
      })
    ).stdout.trim();
    if (branch !== input.branch) {
      throw new Error("Prepared worktree is checked out on another branch.");
    }
    const head = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["rev-parse", "HEAD"],
        cwd: destination,
      })
    ).stdout.trim();
    if (head !== input.baseHead) {
      throw new Error("Prepared worktree is not at the admitted base head.");
    }
    if (input.requireClean === false) {
      return;
    }
    const status = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: destination,
      })
    ).stdout;
    if (status.trim() !== "") {
      throw new Error("Initial worktree must be clean before worker execution.");
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}
