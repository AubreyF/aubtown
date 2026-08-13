import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HostGatewayClient } from "../src/clients/host-gateway.js";
import { CheckpointStorageReceiptIssuer } from "../src/checkpoints/receipt.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { parseSignedHostEnvelope, verifyHostEnvelope } from "../src/security/host-envelope.js";
import { claim } from "./helpers.js";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("HostGatewayClient", () => {
  it("signs quota observations and uses a stable Restate idempotency key", async () => {
    const keys = keyPair();
    let requestedUrl = "";
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080/",
      "macos-executor-1",
      keys.privateKey,
      { next: async () => 7 },
      async (input, init) => {
        requestedUrl = String(input);
        request = init;
        return Response.json({
          kind: "quota-observation",
          hostId: "macos-executor-1",
          sequence: 7,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          decision: {
            action: "admit",
            reason: "headroom-available",
            weeklyUsedPercent: 40,
            dailyUsedPercent: 0,
            observedAt: "2026-08-13T18:00:00.000Z",
          },
        });
      },
    );
    await expect(
      client.observe({
        observation: {
          accountId: "codex-pro-1",
          observedAt: "2026-08-13T18:00:00.000Z",
          primary: {
            usedPercent: 40,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-08-18T08:00:00.000Z",
          },
          activeTurnIds: [],
        },
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).resolves.toMatchObject({ action: "admit" });
    expect(requestedUrl).toContain("HostGateway/macos-executor-1/submit");
    const headers = new Headers(request?.headers);
    expect(headers.get("idempotency-key")).toMatch(/^host-macos-executor-1-7-/u);
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("signs executor polls with the enrolled account scope", async () => {
    const keys = keyPair();
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 8 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "executor-poll",
          hostId: "linux-control-1",
          sequence: 8,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          command: null,
          reason: "no-command",
        });
      },
      () => new Date("2026-08-13T18:00:00.000Z"),
    );
    await expect(client.pollExecutor("codex-pro-1")).resolves.toMatchObject({
      kind: "executor-poll",
      reason: "no-command",
    });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "executor-poll",
      payload: { accountId: "codex-pro-1" },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("signs persisted-turn reconciliation before resume", async () => {
    const keys = keyPair();
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 9 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 9,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
          action: "resume",
          reason: "current",
        });
      },
      () => new Date("2026-08-13T18:00:00.000Z"),
    );
    await expect(
      client.reconcileExecutor({
        commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
        claimId: "claim-1234",
        custodyEpoch: 1,
        accountId: "codex-pro-1",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).resolves.toMatchObject({ action: "resume", reason: "current" });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "executor-reconcile",
      payload: {
        claimId: "claim-1234",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("submits an edge-signed checkpoint receipt through the host envelope", async () => {
    const hostKeys = keyPair();
    const receiptKeys = keyPair();
    const receipt = new CheckpointStorageReceiptIssuer(receiptKeys.privateKey).issue({
      schemaVersion: 1,
      reference: "d".repeat(64),
      contentLength: 1_024,
      hostId: "macos-executor-1",
      grantNonce: "11111111-1111-4111-8111-111111111111",
      manifest: createCheckpointManifest({
        claim: claim({ hostId: "macos-executor-1" }),
        repositoryHead: "a".repeat(40),
        baseHead: "b".repeat(40),
        patch: new TextEncoder().encode("diff --git a/a b/a\n"),
        includedUntrackedPaths: [],
        validationReceipts: [],
        createdAt: "2026-08-13T18:00:00.000Z",
      }),
      storedAt: "2026-08-13T18:00:01.000Z",
    });
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "macos-executor-1",
      hostKeys.privateKey,
      { next: async () => 10 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "checkpoint-receipt",
          hostId: "macos-executor-1",
          sequence: 10,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          reference: receipt.reference,
          storedAt: receipt.storedAt,
        });
      },
      () => new Date("2026-08-13T18:00:02.000Z"),
    );

    await expect(client.submitCheckpointReceipt(receipt)).resolves.toMatchObject({
      kind: "checkpoint-receipt",
      reference: receipt.reference,
    });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "checkpoint-receipt",
      payload: { reference: receipt.reference },
    });
    expect(verifyHostEnvelope(envelope, hostKeys.publicKey)).toBe(true);
  });
});
