import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { FreedAuthorityBridge } from "../src/adapters/freed/authority-bridge.js";
import { createFreedWorkspace } from "../src/adapters/freed/workspace.js";
import { authorityTask, claim, report } from "./helpers.js";

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

  it("refuses worker leases until the task-scoped claim contract exists", async () => {
    const bridge = new FreedAuthorityBridge(new RecordingRunner(), {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
    });
    await expect(
      bridge.acquire({
        binding: {
          qualification: report(),
          authorityTask: authorityTask(),
        claim: claim(),
        accountId: "codex-pro-1",
        driverId: "codex-app-server-v1",
          baseHead: "b".repeat(40),
          target: "shared",
        },
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow(
      "Do not overload nightly-writer or provision worker-specific actors",
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
