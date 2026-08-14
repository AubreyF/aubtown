import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CheckpointStorageReceiptIssuer } from "../src/checkpoints/receipt.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { planCustodyTransfer } from "../src/orchestration/custody-transfer.js";
import { claim } from "./helpers.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const activeClaim = claim({
  hostId: "macos-executor-1",
  workerId: "worker-macos-executor-1",
  claimedAt: "2026-08-12T06:00:00.000Z",
});
const manifest = createCheckpointManifest({
  claim: activeClaim,
  repositoryHead: "a".repeat(40),
  baseHead: "b".repeat(40),
  patch: Buffer.from("unpublished work", "utf8"),
  includedUntrackedPaths: [],
  validationReceipts: ["worker-turn:interrupted"],
  createdAt: "2026-08-12T07:00:00.000Z",
});
const receipt = new CheckpointStorageReceiptIssuer(privateKeyPem).issue({
  schemaVersion: 1,
  reference: "c".repeat(64),
  contentLength: 4_096,
  hostId: activeClaim.hostId,
  grantNonce: "11111111-1111-4111-8111-111111111111",
  manifest,
  storedAt: "2026-08-12T07:01:00.000Z",
});
const mac = {
  id: "macos-executor-1",
  lane: "macos" as const,
  online: true,
  lastHeartbeatAt: "2026-08-12T08:00:00.000Z",
  activeClaims: [activeClaim.claimId],
  accountIds: ["codex-pro-1"],
};
const linux = {
  id: "linux-control-1",
  lane: "linux" as const,
  online: true,
  lastHeartbeatAt: "2026-08-13T08:00:00.000Z",
  activeClaims: [],
  accountIds: ["codex-pro-1"],
};

describe("custody transfer planning", () => {
  it("builds the exact next-epoch transfer and restore after 24 hours offline", () => {
    const result = planCustodyTransfer({
      schemaVersion: 1,
      claim: activeClaim,
      requiredLane: "linux",
      hosts: [mac, linux],
      workspaceRoots: {
        "linux-control-1": "/var/lib/aubtown/workspaces",
        "macos-executor-1": "/Users/worker/.aubtown/workspaces",
      },
      checkpointReceipt: receipt,
      checkpointReceiptPublicKeyPem: publicKeyPem,
      now: "2026-08-13T08:00:01.000Z",
    });
    expect(result).toMatchObject({
      status: "ready",
      transfer: {
        priorEpoch: 1,
        nextEpoch: 2,
        destinationHostId: "linux-control-1",
        destinationWorktree: "/var/lib/aubtown/workspaces/freed-issue-1234",
      },
      nextClaim: {
        custodyEpoch: 2,
        hostId: "linux-control-1",
      },
      restore: {
        priorCustodyEpoch: 1,
        custodyEpoch: 2,
        checkpointReference: receipt.reference,
        checkpointBaseHead: manifest.baseHead,
      },
    });
  });

  it("does not transfer before the 24-hour boundary", () => {
    expect(
      planCustodyTransfer({
        schemaVersion: 1,
        claim: activeClaim,
        requiredLane: "linux",
        hosts: [
          { ...mac, lastHeartbeatAt: "2026-08-12T08:00:02.000Z" },
          linux,
        ],
        workspaceRoots: { "linux-control-1": "/var/lib/aubtown/workspaces" },
        checkpointReceipt: receipt,
        checkpointReceiptPublicKeyPem: publicKeyPem,
        now: "2026-08-13T08:00:01.000Z",
      }),
    ).toMatchObject({ status: "unchanged", decision: { action: "alert-second" } });
  });

  it("blocks macOS-only work and unverifiable checkpoints", () => {
    expect(
      planCustodyTransfer({
        schemaVersion: 1,
        claim: activeClaim,
        requiredLane: "macos",
        hosts: [mac, linux],
        workspaceRoots: { "linux-control-1": "/var/lib/aubtown/workspaces" },
        checkpointReceipt: receipt,
        checkpointReceiptPublicKeyPem: publicKeyPem,
        now: "2026-08-13T08:00:01.000Z",
      }),
    ).toMatchObject({ status: "blocked", reason: "compatible-host-unavailable" });

    expect(
      planCustodyTransfer({
        schemaVersion: 1,
        claim: activeClaim,
        requiredLane: "linux",
        hosts: [mac, linux],
        workspaceRoots: { "linux-control-1": "/var/lib/aubtown/workspaces" },
        checkpointReceipt: { ...receipt, signatureBase64: "invalid" },
        checkpointReceiptPublicKeyPem: publicKeyPem,
        now: "2026-08-13T08:00:01.000Z",
      }),
    ).toMatchObject({ status: "blocked", reason: "checkpoint-receipt-invalid" });
  });
});
