import { describe, expect, it } from "vitest";
import {
  dailyUsagePercent,
  decideQuota,
  losAngelesDayKey,
  mergeUsageObservation,
  selectExecutionAccount,
} from "../src/policy/quota.js";
import { usage } from "./helpers.js";

const NOW = "2026-08-13T08:01:00.000Z";

describe("quota governance", () => {
  it("computes usage against the current rolling-window baseline", () => {
    expect(dailyUsagePercent(usage())).toBe(5);
  });

  it("does not count a changed rolling-window reset estimate as new use", () => {
    const previous = usage();
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T20:00:00.000Z",
        primary: {
          usedPercent: previous.primary.usedPercent,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-25T08:00:00.000Z",
        },
        lifetimeTokens: 1_060_000,
        activeTurnIds: [],
      },
    });
    expect(dailyUsagePercent(merged)).toBe(5);
    expect(merged.dailyBaseline).toEqual({
      ...previous.dailyBaseline,
      resetsAt: "2026-08-25T08:00:00.000Z",
    });
  });

  it("keeps the same baseline within one Los Angeles day", () => {
    const previous = usage({ observedAt: "2026-08-13T08:00:00.000Z" });
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T20:00:00.000Z",
        primary: { ...previous.primary, usedPercent: 41 },
        lifetimeTokens: 1_060_000,
        activeTurnIds: [],
      },
    });
    expect(merged.dailyBaseline).toEqual(previous.dailyBaseline);
  });

  it("resets the baseline at Los Angeles midnight", () => {
    expect(losAngelesDayKey("2026-08-13T06:59:59.000Z")).toBe("2026-08-12");
    expect(losAngelesDayKey("2026-08-13T07:00:00.000Z")).toBe("2026-08-13");
    const previous = usage({
      observedAt: "2026-08-13T06:59:59.000Z",
      dailyConsumption: {
        ...usage().dailyConsumption,
        day: "2026-08-12",
      },
    });
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T07:00:00.000Z",
        primary: { ...previous.primary, usedPercent: 41 },
        lifetimeTokens: 1_060_000,
        activeTurnIds: [],
      },
    });
    expect(merged.dailyBaseline.usedPercent).toBe(41);
  });

  it.each([
    [15, "throttle", "daily-throttle"],
    [20, "stop-admission", "daily-admission-stop"],
    [25, "interrupt", "daily-interrupt"],
  ] as const)("applies the approved daily threshold at %s", (delta, action, reason) => {
    const decision = decideQuota({
      snapshot: usage({
        primary: {
          usedPercent: 35 + delta,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
        dailyConsumption: {
          ...usage().dailyConsumption,
          grossUsedPercent: delta,
        },
      }),
      now: NOW,
    });
    expect(decision).toMatchObject({ action, reason });
  });

  it("interrupts at the autonomous weekly ceiling", () => {
    const decision = decideQuota({
      snapshot: usage({
        primary: {
          usedPercent: 80,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
      }),
      now: NOW,
    });
    expect(decision.reason).toBe("weekly-ceiling");
  });

  it("fails closed when telemetry is stale", () => {
    const decision = decideQuota({
      snapshot: usage({ observedAt: "2026-08-13T07:58:59.000Z" }),
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "interrupt", reason: "telemetry-stale" });
  });

  it("fails closed when telemetry is dated in the future", () => {
    const decision = decideQuota({
      snapshot: usage({ observedAt: "2026-08-13T08:01:01.000Z" }),
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "interrupt", reason: "telemetry-stale" });
  });

  it("accepts rolling-window retreat while cumulative tokens rise", () => {
    const previous = usage();
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T08:01:00.000Z",
        primary: { ...previous.primary, usedPercent: 39 },
        lifetimeTokens: 1_060_000,
        activeTurnIds: [],
      },
    });
    expect(merged.dailyConsumption).toMatchObject({
      grossUsedPercent: 5,
      meterState: "coherent",
    });
    expect(decideQuota({ snapshot: merged, now: "2026-08-13T08:01:00.000Z" }))
      .toMatchObject({ action: "admit", reason: "headroom-available" });
  });

  it("allows token activity below the percentage meter resolution", () => {
    const previous = usage();
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T08:01:00.000Z",
        primary: { ...previous.primary },
        lifetimeTokens: 1_050_001,
        activeTurnIds: [],
      },
    });
    expect(merged.dailyConsumption.meterState).toBe("coherent");
  });

  it("rejects a cumulative token counter that moves backward", () => {
    const previous = usage();
    expect(() =>
      mergeUsageObservation({
        previous,
        observation: {
          accountId: previous.accountId,
          observedAt: "2026-08-13T08:01:00.000Z",
          primary: { ...previous.primary, usedPercent: 41 },
          lifetimeTokens: 1_049_999,
          activeTurnIds: [],
        },
      }),
    ).toThrow("moved backward");
  });

  it("rejects telemetry that is not the exact rolling weekly window", () => {
    expect(() =>
      decideQuota({
        snapshot: usage({
          primary: {
            usedPercent: 20,
            windowDurationMinutes: 300,
            resetsAt: "2026-08-18T08:00:00.000Z",
          },
        }),
        now: NOW,
      }),
    ).toThrow("10,080 minute");
  });

  it("routes future work to the enabled account with most headroom", () => {
    const account = (id: string, usedPercent: number) => ({
      id,
      driverId: "codex",
      enabled: true,
      hostIds: ["linux-control-1"],
      usage: usage({
        accountId: id,
        primary: {
          usedPercent,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
        dailyBaseline: {
          observedAt: "2026-08-13T07:00:00.000Z",
          usedPercent,
          resetsAt: "2026-08-18T08:00:00.000Z",
        },
      }),
    });
    const result = selectExecutionAccount({
      accounts: [account("subscription-b", 60), account("subscription-a", 20)],
      eligibleHostIds: ["linux-control-1"],
      now: NOW,
    });
    expect(result.account?.id).toBe("subscription-a");
  });
});
