import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { FreedClaimBrokerClient } from "../src/adapters/freed/claim-broker.js";
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

class HandlerRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(
    private readonly handler: (
      request: CommandRequest,
      attempt: number,
    ) => Promise<CommandResult> | CommandResult,
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return await this.handler(request, this.requests.length);
  }
}

function binding() {
  return {
    qualification: report(),
    authorityTask: authorityTask({
      state: "approved_for_pr",
      executionAuthority: "pr-only",
    }),
    claim: claim({
      claimId: "claim-1234-epoch-1",
      claimedAt: "2026-08-13T18:00:00.000Z",
    }),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "b".repeat(40),
    target: "shared" as const,
  };
}

function brokerResponse(request: CommandRequest): CommandResult {
  const requestIndex = request.args.indexOf("--request-json");
  const payload = JSON.parse(request.args[requestIndex + 1] ?? "null") as {
    readonly operationId: string;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly bindingDigest: string;
    readonly claim: {
      readonly claimId: string;
      readonly custodyEpoch: number;
      readonly conflictDomainDigest: string;
    };
    readonly requestedAt: string;
  };
  return {
    stderr: "",
    stdout: JSON.stringify({
      ok: true,
      schemaVersion: 1,
      action: "task.claim-acquire",
      result: {
        schemaVersion: 1,
        operationId: payload.operationId,
        taskId: payload.taskId,
        taskRevision: payload.expectedTaskRevision,
        authorityClaimId: payload.claim.claimId,
        custodyEpoch: payload.claim.custodyEpoch,
        bindingDigest: payload.bindingDigest,
        conflictDomainDigest: payload.claim.conflictDomainDigest,
        admission: {
          schemaVersion: 1,
          bridgeId: "freed-authority-v1",
          authorityClaimId: payload.claim.claimId,
          taskId: payload.taskId,
          taskRevision: payload.expectedTaskRevision,
          bindingDigest: payload.bindingDigest,
          authorizedAt: payload.requestedAt,
          expiresAt: "2026-08-13T18:05:00.000Z",
        },
      },
    }),
  };
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
      env: {},
    });
  });

  it("ignores unrelated legacy tasks that predate factory fields", async () => {
    const runner = new RecordingRunner({
      stderr: "",
      stdout: JSON.stringify({
        action: "task.list",
        result: {
          schemaVersion: 1,
          revision: 4,
          tasks: [
            {
              taskId: "legacy-task",
              state: "triaged",
              revision: 1,
              observerAuthority: "plan-only",
              providerAuthority: "forbidden",
              details: { behavioral: false },
            },
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

    await expect(bridge.inspect(report())).resolves.toMatchObject({
      active: true,
      task: { id: "github-issue-1234" },
    });
  });

  it("fails closed when the matching task lacks the factory contract", async () => {
    const runner = new RecordingRunner({
      stderr: "",
      stdout: JSON.stringify({
        action: "task.list",
        result: {
          tasks: [
            {
              taskId: "github-issue-1234",
              state: "triaged",
              revision: 2,
              observerAuthority: "merge-safe",
              providerAuthority: "forbidden",
              details: {
                behavioral: false,
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

    await expect(bridge.inspect(report())).rejects.toThrow("estimatedMinutes");
  });

  it("acquires one exact task-scoped claim through the reviewed broker", async () => {
    const runner = new HandlerRunner((request) => brokerResponse(request));
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
      claimBrokerArgs: ["--profile", "freed"],
    });
    const admission = await bridge.acquire({
      binding: binding(),
      now: "2026-08-13T18:00:00.000Z",
    });
    expect(admission).toMatchObject({
      authorityClaimId: "claim-1234-epoch-1",
      taskId: "github-issue-1234",
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      executable: "/opt/freed/bin/factory-coordinator",
      cwd: "/repo/freed",
      env: {},
      timeoutMs: 13 * 60_000,
    });
    expect(runner.requests[0]?.args.slice(0, -1)).toEqual([
      "--profile",
      "freed",
      "task",
      "claim-acquire",
      "--request-json",
    ]);
    const requestJson = runner.requests[0]?.args.at(-1);
    expect(JSON.parse(requestJson ?? "null")).toMatchObject({
      schemaVersion: 1,
      taskId: "github-issue-1234",
      expectedTaskRevision: 1,
      requestedAt: "2026-08-13T18:00:00.000Z",
      claim: {
        claimedAt: "2026-08-13T18:00:00.000Z",
        claimId: "claim-1234-epoch-1",
        publicationCeiling: "draft-pr",
        accountId: "codex-pro-1",
        driverId: "codex-app-server-v1",
        workLane: "runtime-neutral",
      },
    });
  });

  it("preserves the planned claim time when prelaunch starts later", async () => {
    const runner = new HandlerRunner((request) => brokerResponse(request));
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    await bridge.acquire({
      binding: binding(),
      now: "2026-08-13T18:01:00.000Z",
    });
    const payload = JSON.parse(
      runner.requests[0]?.args.at(-1) ?? "null",
    ) as { requestedAt: string; claim: { claimedAt: string } };
    expect(payload.requestedAt).toBe("2026-08-13T18:00:00.000Z");
    expect(payload.claim.claimedAt).toBe(payload.requestedAt);
  });

  it("retries response loss with the identical claim operation", async () => {
    const runner = new HandlerRunner((request, attempt) => {
      if (attempt === 1) {
        throw new Error("broker response lost");
      }
      return brokerResponse(request);
    });
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    await expect(
      bridge.acquire({
        binding: binding(),
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).resolves.toMatchObject({ authorityClaimId: "claim-1234-epoch-1" });
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0]).toEqual(runner.requests[1]);
  });

  it("does not retry a deterministic structured Freed denial", async () => {
    const denial = Object.assign(new Error("broker rejected the claim"), {
      stdout: "",
      stderr: JSON.stringify({
        ok: false,
        schemaVersion: 1,
        error: {
          code: "claim_epoch_mismatch",
          message: "claim custody epoch is stale",
        },
      }),
    });
    const runner = new HandlerRunner(() => {
      throw denial;
    });
    const client = new FreedClaimBrokerClient(runner, {
      executable: "/opt/freed/bin/factory-coordinator",
      cwd: "/repo/freed",
    });

    await expect(
      client.heartbeat({
        schemaVersion: 1,
        operationId: "5809e845-0e11-4809-aae1-81ae66a469ed",
        taskId: "github-issue-1234",
        taskRevision: 1,
        authorityClaimId: "claim-1234-epoch-1",
        custodyEpoch: 1,
        bindingDigest: "a".repeat(64),
        heartbeatAt: "2026-08-13T18:03:30.000Z",
        executionStage: "running",
      }),
    ).rejects.toBe(denial);
    expect(runner.requests).toHaveLength(1);
  });

  it("rejects a broker response without the standard Freed success envelope", async () => {
    const runner = new HandlerRunner((request) => {
      const response = JSON.parse(brokerResponse(request).stdout) as Record<
        string,
        unknown
      >;
      delete response.ok;
      delete response.schemaVersion;
      return { stdout: JSON.stringify(response), stderr: "" };
    });
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    await expect(
      bridge.acquire({
        binding: binding(),
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("rejects a broker response for another claim", async () => {
    const runner = new HandlerRunner((request) => {
      const response = JSON.parse(brokerResponse(request).stdout) as {
        result: { authorityClaimId: string; admission: { authorityClaimId: string } };
      };
      response.result.authorityClaimId = "claim-substituted";
      response.result.admission.authorityClaimId = "claim-substituted";
      return { stdout: JSON.stringify(response), stderr: "" };
    });
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    await expect(
      bridge.acquire({
        binding: binding(),
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow("does not match the exact dispatch");
  });

  it("blocks non-pilot authority before invoking the broker", async () => {
    const runner = new HandlerRunner((request) => brokerResponse(request));
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    const candidate = binding();
    await expect(
      bridge.acquire({
        binding: {
          ...candidate,
          authorityTask: {
            ...candidate.authorityTask,
            providerAuthority: "approval-required",
          },
        },
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow("outside the runtime-neutral pilot policy");
    expect(runner.requests).toHaveLength(0);
  });

  it("keeps claim acquisition closed when no reviewed broker is installed", async () => {
    const runner = new HandlerRunner((request) => brokerResponse(request));
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
    });
    await expect(
      bridge.acquire({
        binding: binding(),
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow("require the reviewed coordinator broker");
    expect(runner.requests).toHaveLength(0);
  });

  it("releases only the exact admitted claim and retains one retry identity", async () => {
    const runner = new HandlerRunner((request, attempt) => {
      if (attempt === 1) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            schemaVersion: 1,
            action: "task.claim-show",
            result: {
              schemaVersion: 1,
              taskId: "github-issue-1234",
              taskRevision: 1,
              bindingDigest: "a".repeat(64),
              claim: {
                claimId: "claim-1234-epoch-1",
                githubIssue: {
                  number: 1_234,
                  url: "https://github.com/freed-project/freed/issues/1234",
                },
                custodyEpoch: 1,
                hostId: "linux-control-1",
                workerId: "worker-linux-control-1",
                branch: "fix/issue-1234",
                worktree: "/worktrees/1234",
                conflictDomains: ["logical:tooling-validation"],
                conflictDomainDigest: "b".repeat(64),
                claimedAt: "2026-08-13T18:00:00.000Z",
                heartbeatAt: "2026-08-13T18:03:30.000Z",
                baseHead: "b".repeat(40),
                accountId: "codex-pro-1",
                driverId: "codex-app-server-v1",
                target: "shared",
                workLane: "runtime-neutral",
                publicationCeiling: "draft-pr",
                executionStage: "running",
              },
            },
          }),
        };
      }
      if (attempt === 2) {
        throw new Error("release response lost");
      }
      const payload = JSON.parse(request.args.at(-1) ?? "null") as {
        operationId: string;
        taskId: string;
        expectedTaskRevision: number;
        authorityClaimId: string;
        custodyEpoch: number;
        expectedHeartbeatAt: string;
        reason: string;
        releasedAt: string;
      };
      return {
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          schemaVersion: 1,
          action: "task.claim-release",
          result: {
            schemaVersion: 1,
            operationId: payload.operationId,
            taskId: payload.taskId,
            taskRevision: payload.expectedTaskRevision,
            authorityClaimId: payload.authorityClaimId,
            bindingDigest: "a".repeat(64),
            custodyEpoch: payload.custodyEpoch,
            expectedHeartbeatAt: payload.expectedHeartbeatAt,
            reason: payload.reason,
            releasedAt: payload.releasedAt,
          },
        }),
      };
    });
    const bridge = new FreedAuthorityBridge(runner, {
      repositoryRoot: "/repo/freed",
      stateRoot: "/state/freed",
      nodeExecutable: "/node/bin/node",
      claimBrokerExecutable: "/opt/freed/bin/factory-coordinator",
    });
    await expect(
      bridge.release({
        admission: {
          schemaVersion: 1,
          bridgeId: "freed-authority-v1",
          authorityClaimId: "claim-1234-epoch-1",
          taskId: "github-issue-1234",
          taskRevision: 1,
          bindingDigest: "a".repeat(64),
          authorizedAt: "2026-08-13T18:00:00.000Z",
          expiresAt: "2026-08-13T18:05:00.000Z",
        },
        reason: "worker-completed",
        now: "2026-08-13T18:04:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[1]).toEqual(runner.requests[2]);
    expect(runner.requests[0]?.timeoutMs).toBe(120_000);
    expect(runner.requests[1]?.timeoutMs).toBe(13 * 60_000);
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
