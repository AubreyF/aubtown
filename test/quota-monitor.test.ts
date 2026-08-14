import { describe, expect, it } from "vitest";
import type { RawAccountUsageObservation } from "../src/domain/types.js";
import type {
  UsageSource,
  WorkerDriver,
  WorkerTurnHandle,
} from "../src/drivers/worker.js";
import { decideQuota, mergeUsageObservation } from "../src/policy/quota.js";
import { QuotaMonitor } from "../src/supervision/quota-monitor.js";

const handle: WorkerTurnHandle = {
  driverId: "fake",
  threadId: "thread-1",
  turnId: "turn-1",
  startedAt: "2026-08-13T18:00:00.000Z",
};

describe("QuotaMonitor", () => {
  it("interrupts tracked turns at the weekly ceiling", async () => {
    const interrupted: string[] = [];
    const source: UsageSource = {
      id: "fake-usage",
      read: async (accountId, activeTurnIds): Promise<RawAccountUsageObservation> => ({
        accountId,
        observedAt: "2026-08-13T18:00:30.000Z",
        primary: {
          usedPercent: 80,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
        lifetimeTokens: 1_000_000,
        activeTurnIds,
      }),
    };
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => handle,
      recover: async () => "running" as const,
      wait: async () => "completed" as const,
      interrupt: async (turn: WorkerTurnHandle) => {
        interrupted.push(turn.turnId);
      },
    } satisfies WorkerDriver;
    const monitor = new QuotaMonitor(
      source,
      worker,
      {
        observe: async ({ observation, now }) =>
          decideQuota({
            snapshot: mergeUsageObservation({ observation }),
            now,
          }),
      },
      () => new Date("2026-08-13T18:00:31.000Z"),
    );
    monitor.track("codex-pro-1", handle);
    const receipt = await monitor.sample("codex-pro-1");
    expect(receipt.decision.reason).toBe("weekly-ceiling");
    expect(receipt.interruptedTurnIds).toEqual(["turn-1"]);
    expect(interrupted).toEqual(["turn-1"]);
  });

  it("interrupts once when coordinator telemetry remains unavailable", async () => {
    const interrupted: string[] = [];
    let now = new Date("2026-08-13T18:00:00.000Z");
    const source: UsageSource = {
      id: "fake-usage",
      read: async (accountId, activeTurnIds) => ({
        accountId,
        observedAt: now.toISOString(),
        primary: {
          usedPercent: 20,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
        lifetimeTokens: 1_000_000,
        activeTurnIds,
      }),
    };
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => handle,
      recover: async () => "running" as const,
      wait: async () => "completed" as const,
      interrupt: async (turn: WorkerTurnHandle) => {
        interrupted.push(turn.turnId);
      },
    } satisfies WorkerDriver;
    const monitor = new QuotaMonitor(
      source,
      worker,
      {
        observe: async ({ observation, now: observedNow }) =>
          decideQuota({
            snapshot: mergeUsageObservation({ observation }),
            now: observedNow,
          }),
      },
      () => now,
    );
    monitor.track("codex-pro-1", handle);
    await monitor.sample("codex-pro-1");
    now = new Date("2026-08-13T18:01:59.000Z");
    await expect(monitor.enforceTelemetryFreshness("codex-pro-1", 120)).resolves.toEqual([]);
    now = new Date("2026-08-13T18:02:01.000Z");
    await expect(monitor.enforceTelemetryFreshness("codex-pro-1", 120)).resolves.toEqual([
      "turn-1",
    ]);
    await expect(monitor.enforceTelemetryFreshness("codex-pro-1", 120)).resolves.toEqual([]);
    expect(interrupted).toEqual(["turn-1"]);
  });
});
