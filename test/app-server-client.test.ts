import { describe, expect, it } from "vitest";
import {
  CodexAppServerClient,
  type JsonRpcTransport,
} from "../src/drivers/codex/app-server-client.js";
import {
  CodexQuotaSource,
  selectRollingWeeklyWindow,
} from "../src/drivers/codex/quota-source.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { CodexIndependentReviewer } from "../src/adjudication/codex-reviewer.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import { claim, FREED_REPOSITORY, report } from "./helpers.js";

class FakeTransport implements JsonRpcTransport {
  readonly messages: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();
  readonly failureListeners = new Set<(error: Error) => void>();

  constructor(private readonly usageResult?: unknown) {}

  async send(message: unknown): Promise<unknown> {
    this.messages.push(message);
    const method = (message as { method?: string }).method;
    if (method === "initialize") {
      return { userAgent: "fake" };
    }
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          primary: {
            usedPercent: 42,
            windowDurationMins: 10_080,
            resetsAt: 1_787_054_400,
          },
        },
      };
    }
    if (method === "account/usage/read") {
      return this.usageResult ?? {
        summary: { lifetimeTokens: 1_234_567, peakDailyTokens: 45_678 },
        dailyUsageBuckets: [{ startDate: "2026-08-13", tokens: 12_345 }],
      };
    }
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
            ],
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } };
    }
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1", status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    throw new Error(`Unexpected method ${String(method)}.`);
  }

  async notify(message: unknown): Promise<void> {
    this.messages.push(message);
  }

  onNotification(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) {
      listener(error);
    }
  }

  async close(): Promise<void> {}
}

describe("Codex app-server integration", () => {
  it("initializes once and reads official rate-limit fields", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const first = await client.readRateLimits();
    const second = await client.readRateLimits();
    expect(first.rateLimits.primary.windowDurationMins).toBe(10_080);
    expect(second.rateLimits.primary.usedPercent).toBe(42);
    expect(
      transport.messages.filter(
        (message) => (message as { method?: string }).method === "initialize",
      ),
    ).toHaveLength(1);
  });

  it("builds a central snapshot without moving account credentials", async () => {
    const client = new CodexAppServerClient(new FakeTransport());
    const source = new CodexQuotaSource(
      client,
      () => new Date("2026-08-13T08:00:00.000Z"),
    );
    const snapshot = await source.read("codex-pro-1", ["turn-1"]);
    expect(snapshot).toMatchObject({
      accountId: "codex-pro-1",
      primary: { usedPercent: 42, windowDurationMinutes: 10_080 },
      lifetimeTokens: 1_234_567,
      activeTurnIds: ["turn-1"],
    });
  });

  it("fails closed when cumulative token activity is unavailable", async () => {
    const client = new CodexAppServerClient(
      new FakeTransport({
        summary: { lifetimeTokens: null },
        dailyUsageBuckets: null,
      }),
    );
    const source = new CodexQuotaSource(client);
    await expect(source.read("codex-pro-1", [])).rejects.toThrow(
      "Daily governance must fail closed",
    );
  });

  it("selects the actual weekly window instead of assuming primary means weekly", () => {
    expect(
      selectRollingWeeklyWindow({
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_000 },
          secondary: {
            usedPercent: 63,
            windowDurationMins: 10_080,
            resetsAt: 2_000,
          },
        },
      }).usedPercent,
    ).toBe(63);
  });

  it("fails closed when app-server omits the weekly window", () => {
    expect(() =>
      selectRollingWeeklyWindow({
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_000 },
          secondary: null,
        },
      }),
    ).toThrow("10,080 minute rolling window");
  });

  it("sends a targeted turn interrupt", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    await client.interrupt("thread-1", "turn-1");
    expect(transport.messages.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("requires the exact model and reasoning effort advertised by app-server", async () => {
    const client = new CodexAppServerClient(new FakeTransport());
    await expect(
      client.assertModelCallable({ model: "gpt-5.6-sol", effort: "high" }),
    ).resolves.toMatchObject({ model: "gpt-5.6-sol" });
    await expect(
      client.assertModelCallable({ model: "gpt-5.6-sol", effort: "xhigh" }),
    ).rejects.toThrow("did not advertise reasoning effort xhigh");
    await expect(
      client.assertModelCallable({ model: "future-model", effort: "high" }),
    ).rejects.toThrow("did not advertise future-model as callable");
  });

  it("starts one workspace-scoped worker thread and preserves completion", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const driver = new CodexDriver(client, {
      model: "gpt-5.6-sol",
      effort: "high",
      now: () => new Date("2026-08-13T08:00:00.000Z"),
    });
    const handle = await driver.start({
      claim: claim(),
      qualification: report(),
      prompt: "Implement the qualified issue within the publication ceiling.",
      repositoryRoot: "/worktrees/1234",
    });
    const threadRequest = transport.messages.find(
      (message) => (message as { method?: string }).method === "thread/start",
    );
    const turnRequest = transport.messages.find(
      (message) => (message as { method?: string }).method === "turn/start",
    );
    expect(threadRequest).toMatchObject({
      params: {
        cwd: "/worktrees/1234",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
        model: "gpt-5.6-sol",
      },
    });
    expect(turnRequest).toMatchObject({
      params: {
        threadId: "thread-1",
        cwd: "/worktrees/1234",
        model: "gpt-5.6-sol",
        effort: "high",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/worktrees/1234"],
        },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    await expect(driver.wait(handle)).resolves.toBe("completed");
  });

  it("rejects an active turn waiter when app-server fails", async () => {
    const transport = new FakeTransport();
    const driver = new CodexDriver(new CodexAppServerClient(transport), {
      model: "gpt-5.6-sol",
      effort: "high",
    });
    const handle = await driver.start({
      claim: claim(),
      qualification: report(),
      prompt: "Implement the qualified issue.",
      repositoryRoot: "/worktrees/1234",
    });
    const completion = driver.wait(handle);
    transport.fail(new Error("app-server child exited unexpectedly"));
    await expect(completion).rejects.toThrow(
      "app-server child exited unexpectedly",
    );
  });

  it("runs independent review in a fresh read-only structured thread", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const reviewer = new CodexIndependentReviewer(client, {
      model: "gpt-5.6-sol",
      effort: "high",
      now: () => new Date("2026-08-13T08:00:00.000Z"),
    });
    const workProduct: WorkProductIdentity = {
      schemaVersion: 1,
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      claimId: "claim-1234",
      custodyEpoch: 1,
      hostId: "linux-control-1",
      branch: "fix/deterministic-validation",
      worktree: "/worktrees/1234",
      commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
      checkpointReference: "d".repeat(64),
      baseHead: "a".repeat(40),
      head: "c".repeat(40),
      patchDigest: "e".repeat(64),
      implementation: {
        driverId: "codex-app-server-v1",
        threadId: "implementation-thread",
        turnId: "implementation-turn",
      },
    };
    const handle = await reviewer.start({
      workProduct,
      qualification: report(),
      repositoryRoot: "/worktrees/1234",
    });
    const threadRequest = transport.messages.find(
      (message) => (message as { method?: string }).method === "thread/start",
    );
    const turnRequest = transport.messages.find(
      (message) => (message as { method?: string }).method === "turn/start",
    );
    expect(threadRequest).toMatchObject({
      params: { sandbox: "readOnly", cwd: "/worktrees/1234" },
    });
    expect(turnRequest).toMatchObject({
      params: {
        threadId: "thread-1",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: {
          required: ["verdict", "summary", "findings"],
          additionalProperties: false,
        },
      },
    });
    expect(turnRequest).toMatchObject({
      params: {
        input: [
          {
            text: expect.stringContaining(
              `immutable base commit ${workProduct.baseHead}`,
            ),
          },
        ],
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId: handle.threadId,
        turnId: handle.turnId,
        completedAtMs: 1_786_608_000_000,
        item: {
          type: "agentMessage",
          id: "message-1",
          phase: "final_answer",
          text: JSON.stringify({
            verdict: "pass",
            summary: "No correctness findings.",
            findings: [],
          }),
        },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { turn: { id: handle.turnId, status: "completed" } },
    });
    await expect(reviewer.wait(handle)).resolves.toMatchObject({
      verdict: "pass",
      summary: "No correctness findings.",
      reviewer: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
      workProduct,
    });
  });

  it("recovers an in-progress turn from persisted app-server history", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const driver = new CodexDriver(client, {
      model: "gpt-5.6-sol",
      effort: "high",
    });
    await expect(
      driver.recover(
        {
          driverId: driver.id,
          threadId: "thread-1",
          turnId: "turn-1",
          startedAt: "2026-08-13T08:00:00.000Z",
        },
        "/worktrees/1234",
      ),
    ).resolves.toBe("running");
    expect(transport.messages.at(-1)).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        cwd: "/worktrees/1234",
        model: "gpt-5.6-sol",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      },
    });
  });
});
