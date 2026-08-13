import { describe, expect, it } from "vitest";
import {
  decideCustody,
  isCheckpointPathAllowed,
  validateCheckpointForResume,
} from "../src/policy/custody.js";
import { claim } from "./helpers.js";

const linux = {
  id: "linux-control-1",
  lane: "linux" as const,
  online: true,
  lastHeartbeatAt: "2026-08-13T08:00:00.000Z",
  activeClaims: [],
  accountIds: ["codex-pro-1"],
};

const mac = {
  id: "macos-executor-1",
  lane: "macos" as const,
  online: false,
  lastHeartbeatAt: "2026-08-12T08:00:00.000Z",
  activeClaims: ["claim-1234"],
  accountIds: ["codex-pro-1"],
};

describe("custody", () => {
  it("transfers portable work after 24 hours and advances one epoch", () => {
    const result = decideCustody({
      claim: claim({ hostId: mac.id }),
      sourceHost: mac,
      hosts: [mac, linux],
      requiredLane: "linux",
      now: "2026-08-13T08:00:01.000Z",
    });
    expect(result).toMatchObject({
      action: "transfer",
      destinationHostId: linux.id,
      nextCustodyEpoch: 2,
    });
  });

  it("blocks macOS-only work when no Mac is online", () => {
    const result = decideCustody({
      claim: claim({ hostId: mac.id }),
      sourceHost: mac,
      hosts: [mac, linux],
      requiredLane: "macos",
      now: "2026-08-13T08:00:01.000Z",
    });
    expect(result.action).toBe("block-no-host");
  });

  it("rejects a stale checkpoint epoch", () => {
    const active = claim();
    const result = validateCheckpointForResume({
      claim: active,
      expectedEpoch: 2,
      checkpoint: {
        schemaVersion: 1,
        claimId: active.claimId,
        custodyEpoch: 0,
        sourceHostId: active.hostId,
        repositoryHead: "a".repeat(40),
        baseHead: "b".repeat(40),
        patchDigest: "c".repeat(64),
        includedUntrackedPaths: [],
        validationReceipts: [],
        createdAt: "2026-08-13T08:00:00.000Z",
      },
    });
    expect(result).toEqual({ valid: false, reason: "checkpoint-epoch-mismatch" });
  });

  it.each([
    ["src/index.ts", true],
    [".env", false],
    ["node_modules/pkg/index.js", false],
    ["credentials/app.pem", false],
    ["../outside", false],
  ] as const)("classifies checkpoint path %s", (path, expected) => {
    expect(isCheckpointPathAllowed(path)).toBe(expected);
  });
});
