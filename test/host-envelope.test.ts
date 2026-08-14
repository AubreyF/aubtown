import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hostEnvelopeDigest,
  parseSignedHostEnvelope,
  signHostEnvelope,
  type SignedHostEnvelope,
  verifyHostEnvelope,
} from "../src/security/host-envelope.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("signed host envelopes", () => {
  it("authenticates identity, sequence, kind, timestamp, and payload", () => {
    const key = keys();
    const signed = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "macos-executor-1",
        sequence: 41,
        issuedAt: "2026-08-13T18:00:00.000Z",
        kind: "heartbeat",
        payload: {
          hostId: "macos-executor-1",
          lane: "macos",
          observedAt: "2026-08-13T18:00:00.000Z",
          activeClaims: ["claim-1234"],
          accountIds: ["codex-pro-1"],
        },
      },
      key.privateKey,
    );
    expect(verifyHostEnvelope(parseSignedHostEnvelope(signed), key.publicKey)).toBe(true);
    expect(hostEnvelopeDigest(signed)).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      verifyHostEnvelope(
        { ...signed, sequence: 42 },
        key.publicKey,
      ),
    ).toBe(false);
  });

  it("rejects a non-Ed25519 enrollment key", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const key = keys();
    const signed = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "linux-control-1",
        sequence: 1,
        issuedAt: "2026-08-13T18:00:00.000Z",
        kind: "quota-observation",
        payload: {
          observation: {
            accountId: "codex-pro-1",
            observedAt: "2026-08-13T18:00:00.000Z",
            primary: {
              usedPercent: 40,
              windowDurationMinutes: 10_080,
              resetsAt: "2026-08-18T08:00:00.000Z",
            },
            lifetimeTokens: 1_000_000,
            activeTurnIds: [],
          },
        },
      },
      key.privateKey,
    );
    expect(() => verifyHostEnvelope(signed, publicKey)).toThrow("Ed25519");
  });

  it("authenticates executor polling account scope", () => {
    const key = keys();
    const signed = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "linux-control-1",
        sequence: 9,
        issuedAt: "2026-08-13T18:00:00.000Z",
        kind: "executor-poll",
        payload: { accountId: "codex-pro-1" },
      },
      key.privateKey,
    );
    expect(verifyHostEnvelope(signed, key.publicKey)).toBe(true);
    expect(
      verifyHostEnvelope(
        {
          ...signed,
          payload: { accountId: "codex-pro-2" },
        } as SignedHostEnvelope,
        key.publicKey,
      ),
    ).toBe(false);
  });
});
