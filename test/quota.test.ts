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

  it("starts a new daily delta when the rolling window resets", () => {
    expect(
      dailyUsagePercent(
        usage({
          primary: {
            usedPercent: 3,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-08-25T08:00:00.000Z",
          },
        }),
      ),
    ).toBe(3);
  });

  it("keeps the same baseline within one Los Angeles day", () => {
    const previous = usage({ observedAt: "2026-08-13T08:00:00.000Z" });
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T20:00:00.000Z",
        primary: { ...previous.primary, usedPercent: 41 },
        activeTurnIds: [],
      },
    });
    expect(merged.dailyBaseline).toEqual(previous.dailyBaseline);
  });

  it("resets the baseline at Los Angeles midnight", () => {
    expect(losAngelesDayKey("2026-08-13T06:59:59.000Z")).toBe("2026-08-12");
    expect(losAngelesDayKey("2026-08-13T07:00:00.000Z")).toBe("2026-08-13");
    const previous = usage({ observedAt: "2026-08-13T06:59:59.000Z" });
    const merged = mergeUsageObservation({
      previous,
      observation: {
        accountId: previous.accountId,
        observedAt: "2026-08-13T07:00:00.000Z",
        primary: { ...previous.primary, usedPercent: 41 },
        activeTurnIds: [],
      },
    });
    expect(merged.dailyBaseline.usedPercent).toBe(41);
  });

  it.each([
    [7, "throttle", "daily-throttle"],
    [9, "stop-admission", "daily-admission-stop"],
    [10, "interrupt", "daily-interrupt"],
  ] as const)("applies the approved daily threshold at %s", (delta, action, reason) => {
    const decision = decideQuota({
      snapshot: usage({
        primary: {
          usedPercent: 35 + delta,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-18T08:00:00.000Z",
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
