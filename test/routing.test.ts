import { describe, expect, it } from "vitest";
import type { ExecutionAccount, HostRecord } from "../src/domain/types.js";
import { selectExecutionRoute } from "../src/policy/routing.js";
import { usage } from "./helpers.js";

const hosts: readonly HostRecord[] = [
  {
    id: "linux-control-1",
    lane: "linux",
    online: true,
    lastHeartbeatAt: "2026-08-13T18:00:00.000Z",
    activeClaims: [],
    accountIds: ["account-linux"],
  },
  {
    id: "macos-executor-1",
    lane: "macos",
    online: false,
    lastHeartbeatAt: "2026-08-13T17:00:00.000Z",
    activeClaims: [],
    accountIds: ["account-mac"],
  },
];

function account(input: {
  readonly id: string;
  readonly hostId: string;
  readonly usedPercent: number;
}): ExecutionAccount {
  return {
    id: input.id,
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: [input.hostId],
    usage: usage({
      observedAt: "2026-08-13T18:00:00.000Z",
      primary: {
        usedPercent: input.usedPercent,
        windowDurationMinutes: 10_080,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
      dailyBaseline: {
        observedAt: "2026-08-13T17:00:00.000Z",
        usedPercent: input.usedPercent,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
    }),
  };
}

describe("selectExecutionRoute", () => {
  it("keeps portable work moving on Linux while the Mac is offline", () => {
    const decision = selectExecutionRoute({
      requiredLane: "linux",
      hosts,
      accounts: [
        account({ id: "account-linux", hostId: "linux-control-1", usedPercent: 20 }),
        account({ id: "account-mac", hostId: "macos-executor-1", usedPercent: 10 }),
      ],
      now: "2026-08-13T18:00:30.000Z",
    });
    expect(decision.reason).toBe("selected");
    expect(decision.route?.host.id).toBe("linux-control-1");
  });

  it("blocks macOS work when no Mac executor is online", () => {
    expect(
      selectExecutionRoute({
        requiredLane: "macos",
        hosts,
        accounts: [],
        now: "2026-08-13T18:00:30.000Z",
      }).reason,
    ).toBe("no-host");
  });

  it("can balance future accounts by measured headroom", () => {
    const onlineHosts = hosts.map((host) => ({ ...host, online: true }));
    const decision = selectExecutionRoute({
      requiredLane: "linux",
      hosts: onlineHosts,
      accounts: [
        account({ id: "account-linux", hostId: "linux-control-1", usedPercent: 55 }),
        account({ id: "account-mac", hostId: "macos-executor-1", usedPercent: 20 }),
      ],
      now: "2026-08-13T18:00:30.000Z",
    });
    expect(decision.route?.account.id).toBe("account-mac");
  });
});
