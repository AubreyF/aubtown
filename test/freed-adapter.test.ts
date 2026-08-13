import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { FreedAuthorityBridge } from "../src/adapters/freed/authority-bridge.js";
import { createFreedWorkspace } from "../src/adapters/freed/workspace.js";
import { report } from "./helpers.js";

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly result: CommandResult = { stdout: "{}", stderr: "" }) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe("Freed adapter", () => {
  it("reads authority only through the supported control command", async () => {
    const runner = new RecordingRunner({
      stderr: "",
      stdout: JSON.stringify({
        action: "task.list",
        result: {
          schemaVersion: 1,
          revision: 4,
          tasks: [
            {
              taskId: "github-issue-1234",
              state: "triaged",
              revision: 2,
              observerAuthority: "merge-safe",
              providerAuthority: "forbidden",
              details: {
                behavioral: false,
                estimatedMinutes: 20,
                githubIssue: {
                  number: 1_234,
                  url: "https://github.com/freed-project/freed/issues/1234",
                },
              },
            },
          ],
        },
      }),
    });
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
    });
    const result = await bridge.inspect(report());
    expect(result.active).toBe(true);
    expect(runner.requests[0]).toMatchObject({
      executable: "/node/bin/node",
      args: [
        "scripts/automation-control.mjs",
        "task",
        "list",
        "--state-root",
        "/state/freed",
      ],
    });
  });

  it("refuses to overload the nightly writer when worker authority is absent", async () => {
    const bridge = new FreedAuthorityBridge(new RecordingRunner(), {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
    });
    await expect(bridge.acquire(report(), "worker-1")).rejects.toThrow(
      "Do not overload nightly-writer",
    );
  });

  it("creates workspaces only through Freed's helper and fresh origin/dev", async () => {
    const runner = new RecordingRunner();
    await createFreedWorkspace(runner, {
      repositoryRoot: "/repo/freed",
      worktreePath: "/worktrees/1234",
      branch: "fix/deterministic-validation",
      target: "shared",
    });
    expect(runner.requests[0]).toEqual({
      executable: "/repo/freed/scripts/worktree-add.sh",
      args: [
        "/worktrees/1234",
        "-b",
        "fix/deterministic-validation",
        "origin/dev",
        "--target",
        "shared",
        "--swarm",
      ],
      cwd: "/repo/freed",
    });
  });
});
