import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import {
  CheckpointStorageReceiptIssuer,
  verifyCheckpointStorageReceipt,
} from "../src/checkpoints/receipt.js";
import { claim } from "./helpers.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("checkpoint storage receipts", () => {
  it("authenticates the stored object, source custody, and checkpoint manifest", () => {
    const key = keys();
    const receipt = new CheckpointStorageReceiptIssuer(key.privateKey).issue({
      schemaVersion: 1,
      reference: "a".repeat(64),
      contentLength: 1_024,
      hostId: "macos-executor-1",
      grantNonce: "11111111-1111-4111-8111-111111111111",
      manifest: createCheckpointManifest({
        claim: claim({ hostId: "macos-executor-1" }),
        repositoryHead: "b".repeat(40),
        baseHead: "c".repeat(40),
        patch: new TextEncoder().encode("diff --git a/a b/a\n"),
        includedUntrackedPaths: [],
        validationReceipts: ["focused-test:passed"],
        createdAt: "2026-08-13T18:00:00.000Z",
      }),
      storedAt: "2026-08-13T18:00:01.000Z",
    });

    expect(
      verifyCheckpointStorageReceipt({
        receipt,
        publicKeyPem: key.publicKey,
      }),
    ).toEqual(receipt);
  });

  it("rejects a forged manifest even when its outer shape remains valid", () => {
    const key = keys();
    const receipt = new CheckpointStorageReceiptIssuer(key.privateKey).issue({
      schemaVersion: 1,
      reference: "a".repeat(64),
      contentLength: 1_024,
      hostId: "macos-executor-1",
      grantNonce: "11111111-1111-4111-8111-111111111111",
      manifest: createCheckpointManifest({
        claim: claim({ hostId: "macos-executor-1" }),
        repositoryHead: "b".repeat(40),
        baseHead: "c".repeat(40),
        patch: new TextEncoder().encode("diff --git a/a b/a\n"),
        includedUntrackedPaths: [],
        validationReceipts: [],
        createdAt: "2026-08-13T18:00:00.000Z",
      }),
      storedAt: "2026-08-13T18:00:01.000Z",
    });

    expect(() =>
      verifyCheckpointStorageReceipt({
        receipt: {
          ...receipt,
          manifest: { ...receipt.manifest, custodyEpoch: 2 },
        },
        publicKeyPem: key.publicKey,
      }),
    ).toThrow("signature is invalid");
  });
});
