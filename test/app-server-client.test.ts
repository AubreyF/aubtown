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
import { claim, report } from "./helpers.js";

class FakeTransport implements JsonRpcTransport {
  readonly messages: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();

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
      return { summary: null, dailyUsageBuckets: null };
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

  emit(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
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
      activeTurnIds: ["turn-1"],
    });
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
});
