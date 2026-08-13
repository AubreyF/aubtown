import type { CommandRunner } from "../command-runner.js";

export interface FreedWorkspaceRequest {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly target: string;
}

export async function createFreedWorkspace(
  runner: CommandRunner,
  request: FreedWorkspaceRequest,
): Promise<void> {
  await runner.run({
    executable: `${request.repositoryRoot}/scripts/worktree-add.sh`,
    args: [
      request.worktreePath,
      "-b",
      request.branch,
      "origin/dev",
      "--target",
      request.target,
      "--swarm",
    ],
    cwd: request.repositoryRoot,
  });
}
