import type { CommandRunner } from "../adapters/command-runner.js";
import type { ExecutorStartCommand } from "./command.js";

const FORBIDDEN_AUTHORSHIP = /\b(?:codex|symphony|openhands|openai|agent)\b/iu;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ExecutionCandidateFinalizer {
  finalize(
    command: ExecutorStartCommand,
    finalizationNonce: string,
  ): Promise<{ readonly head: string }>;
}

export class GitExecutionCandidateFinalizer
  implements ExecutionCandidateFinalizer
{
  constructor(
    private readonly runner: CommandRunner,
    private readonly gitExecutable: string,
  ) {}

  async finalize(
    command: ExecutorStartCommand,
    finalizationNonce: string,
  ): Promise<{ readonly head: string }> {
    if (!UUID.test(finalizationNonce)) {
      throw new Error("Candidate finalization nonce must be a UUID.");
    }
    const root = command.repositoryRoot;
    const branch = await this.#line(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (branch !== command.claim.branch) {
      throw new Error("Candidate finalizer found another branch.");
    }
    const base = command.baseHead;
    await this.runner.run({
      executable: this.gitExecutable,
      args: ["cat-file", "-e", `${base}^{commit}`],
      cwd: root,
    });
    const head = await this.#sha(root, ["rev-parse", "HEAD"]);
    const title = `fix: resolve issue #${command.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
    if (FORBIDDEN_AUTHORSHIP.test(title)) {
      throw new Error("Candidate title contains an authorship giveaway.");
    }
    const changedPaths = await this.#changedPaths(root, base);
    this.#assertOwned(command, changedPaths);
    const status = await this.#status(root);
    if (status === "") {
      await this.#assertFinalizedCommit({
        root,
        base,
        head,
        title,
        finalizationNonce,
      });
      return { head };
    }
    if (head !== base) {
      throw new Error(
        "Worker created a commit before trusted candidate finalization.",
      );
    }
    if (changedPaths.length === 0) {
      throw new Error("Completed worker produced no candidate changes.");
    }
    await this.runner.run({
      executable: this.gitExecutable,
      args: ["add", "--all", "--", ...changedPaths],
      cwd: root,
      timeoutMs: 60_000,
    });
    await this.runner.run({
      executable: this.gitExecutable,
      args: [
        "commit",
        "-m",
        title,
        "-m",
        `(AI Generated).\n\nExecution-Receipt: ${finalizationNonce}`,
      ],
      cwd: root,
      timeoutMs: 60_000,
    });
    const finalizedHead = await this.#sha(root, ["rev-parse", "HEAD"]);
    if ((await this.#status(root)) !== "") {
      throw new Error("Candidate worktree is not clean after finalization.");
    }
    await this.#assertFinalizedCommit({
      root,
      base,
      head: finalizedHead,
      title,
      finalizationNonce,
    });
    return { head: finalizedHead };
  }

  async #assertFinalizedCommit(input: {
    readonly root: string;
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly finalizationNonce: string;
  }): Promise<void> {
    if (input.head === input.base) {
      throw new Error("Completed worker produced no candidate commit.");
    }
    const count = await this.#line(input.root, [
      "rev-list",
      "--count",
      `${input.base}..${input.head}`,
    ]);
    const message = await this.#line(input.root, [
      "show",
      "-s",
      "--format=%B",
      input.head,
    ]);
    const expectedMessage = `${input.title}\n\n(AI Generated).\n\nExecution-Receipt: ${input.finalizationNonce}`;
    if (count !== "1" || message !== expectedMessage) {
      throw new Error("Candidate is not the one trusted finalizer commit.");
    }
  }

  async #changedPaths(root: string, base: string): Promise<readonly string[]> {
    const tracked = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["diff", "--name-only", "--no-renames", "-z", base, "--", "."],
        cwd: root,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    const untracked = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["ls-files", "--others", "--exclude-standard", "-z"],
        cwd: root,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  #assertOwned(
    command: ExecutorStartCommand,
    paths: readonly string[],
  ): void {
    const owned = command.qualification.evidence.ownedPaths ?? [];
    if (owned.length === 0) {
      throw new Error("Candidate has no qualified owned paths.");
    }
    for (const path of paths) {
      if (
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        path === ".github/workflows" ||
        path.startsWith(".github/workflows/")
      ) {
        throw new Error(`Candidate path is forbidden: ${path}`);
      }
      const allowed = owned.some(
        (qualified) => path === qualified || path.startsWith(`${qualified}/`),
      );
      if (!allowed) {
        throw new Error(`Candidate path is outside qualified ownership: ${path}`);
      }
    }
  }

  async #status(root: string): Promise<string> {
    return (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: root,
      })
    ).stdout.trim();
  }

  async #sha(root: string, args: readonly string[]): Promise<string> {
    const value = await this.#line(root, args);
    if (!GIT_SHA.test(value)) {
      throw new Error(`Git did not return one SHA for ${args.join(" ")}.`);
    }
    return value;
  }

  async #line(root: string, args: readonly string[]): Promise<string> {
    return (
      await this.runner.run({
        executable: this.gitExecutable,
        args,
        cwd: root,
      })
    ).stdout.trim();
  }
}
