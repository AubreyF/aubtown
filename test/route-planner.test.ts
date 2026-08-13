import { describe, expect, it } from "vitest";
import type { HostRecord } from "../src/domain/types.js";
import { planExecutionRouteFromState } from "../src/orchestration/route-planner.js";
import { usage } from "./helpers.js";

const now = "2026-08-13T18:00:30.000Z";
const hosts: readonly HostRecord[] = [
  {
    id: "linux-control-1",
    lane: "linux",
    online: true,
    lastHeartbeatAt: "2026-08-13T18:00:00.000Z",
    activeClaims: [],
    accountIds: ["subscription-linux"],
  },
  {
    id: "macos-executor-1",
    lane: "macos",
    online: true,
    lastHeartbeatAt: "2026-08-13T18:00:00.000Z",
    activeClaims: [],
    accountIds: ["subscription-mac"],
  },
];
const profiles = {
  "subscription-linux": {
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: ["linux-control-1"],
  },
  "subscription-mac": {
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: ["macos-executor-1"],
  },
};

function accountUsage(accountId: string, usedPercent: number) {
  return usage({
    accountId,
    observedAt: "2026-08-13T18:00:00.000Z",
    primary: {
      usedPercent,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    dailyBaseline: {
      observedAt: "2026-08-13T17:00:00.000Z",
      usedPercent,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
  });
}

describe("durable route planning", () => {
  it("balances portable work across enrolled subscriptions by measured headroom", () => {
    expect(
      planExecutionRouteFromState({
        requiredLane: "linux",
        hosts,
        profiles,
        usageByAccountId: {
          "subscription-linux": accountUsage("subscription-linux", 60),
          "subscription-mac": accountUsage("subscription-mac", 20),
        },
        now,
      }),
    ).toMatchObject({
      reason: "selected",
      route: {
        hostId: "macos-executor-1",
        accountId: "subscription-mac",
      },
    });
  });

  it("keeps portable work on Linux when the Mac is offline", () => {
    const withoutMac = hosts.map((host) =>
      host.id === "macos-executor-1" ? { ...host, online: false } : host,
    );
    expect(
      planExecutionRouteFromState({
        requiredLane: "linux",
        hosts: withoutMac,
        profiles,
        usageByAccountId: {
          "subscription-linux": accountUsage("subscription-linux", 30),
          "subscription-mac": accountUsage("subscription-mac", 10),
        },
        now,
      }),
    ).toMatchObject({
      reason: "selected",
      route: { hostId: "linux-control-1", accountId: "subscription-linux" },
    });
    expect(
      planExecutionRouteFromState({
        requiredLane: "macos",
        hosts: withoutMac,
        profiles,
        usageByAccountId: {
          "subscription-linux": accountUsage("subscription-linux", 30),
          "subscription-mac": accountUsage("subscription-mac", 10),
        },
        now,
      }).reason,
    ).toBe("no-host");
  });

  it("fails closed when every compatible account lacks weekly telemetry", () => {
    expect(
      planExecutionRouteFromState({
        requiredLane: "linux",
        hosts,
        profiles,
        usageByAccountId: {
          "subscription-linux": null,
          "subscription-mac": null,
        },
        now,
      }),
    ).toEqual({
      reason: "telemetry-unavailable",
      missingTelemetryAccountIds: ["subscription-linux", "subscription-mac"],
    });
  });

  it("ignores an account omitted from its host's current heartbeat", () => {
    const quietHosts = hosts.map((host) => ({ ...host, accountIds: [] }));
    expect(
      planExecutionRouteFromState({
        requiredLane: "linux",
        hosts: quietHosts,
        profiles,
        usageByAccountId: {
          "subscription-linux": accountUsage("subscription-linux", 20),
          "subscription-mac": accountUsage("subscription-mac", 10),
        },
        now,
      }).reason,
    ).toBe("no-account");
  });
});
