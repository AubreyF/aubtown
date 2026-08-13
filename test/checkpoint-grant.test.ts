import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CheckpointGrantIssuer,
  verifyCheckpointGrant,
  type CheckpointGrantRequest,
} from "../src/checkpoints/grant.js";
import { claim } from "./helpers.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const request: CheckpointGrantRequest = {
  repository: {
    owner: "freed-project",
    name: "freed",
    defaultBranch: "dev",
  },
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  checkpointEpoch: 1,
  operation: "upload",
  reference: "a".repeat(64),
  contentLength: 12_345,
};

describe("checkpoint transfer grants", () => {
  it("binds a five-minute capability to current host custody and exact object operation", () => {
    const key = keys();
    const issuer = new CheckpointGrantIssuer(
      key.privateKey,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const grant = issuer.issue({
      currentClaim: claim(),
      requestingHostId: "linux-control-1",
      request,
      issuedAt: "2026-08-13T18:00:00.000Z",
    });
    expect(grant.expiresAt).toBe("2026-08-13T18:05:00.000Z");
    expect(() =>
      verifyCheckpointGrant({
        grant,
        publicKeyPem: key.publicKey,
        now: "2026-08-13T18:04:59.000Z",
        expectedHostId: "linux-control-1",
        expectedOperation: "upload",
        expectedReference: request.reference,
        expectedContentLength: request.contentLength,
      }),
    ).not.toThrow();
  });

  it("rejects stale custody before issuing a capability", () => {
    const issuer = new CheckpointGrantIssuer(keys().privateKey);
    expect(() =>
      issuer.issue({
        currentClaim: claim({ custodyEpoch: 2 }),
        requestingHostId: "linux-control-1",
        request,
        issuedAt: "2026-08-13T18:00:00.000Z",
      }),
    ).toThrow("current claim custody");
  });

  it("rejects tampering, expiry, and operation substitution", () => {
    const key = keys();
    const issuer = new CheckpointGrantIssuer(key.privateKey);
    const grant = issuer.issue({
      currentClaim: claim(),
      requestingHostId: "linux-control-1",
      request,
      issuedAt: "2026-08-13T18:00:00.000Z",
    });
    const verify = (overrides: Partial<Parameters<typeof verifyCheckpointGrant>[0]> = {}) =>
      verifyCheckpointGrant({
        grant,
        publicKeyPem: key.publicKey,
        now: "2026-08-13T18:01:00.000Z",
        expectedHostId: "linux-control-1",
        expectedOperation: "upload",
        expectedReference: request.reference,
        expectedContentLength: request.contentLength,
        ...overrides,
      });
    expect(() => verify({ grant: { ...grant, contentLength: 12_346 } })).toThrow("signature");
    expect(() => verify({ now: "2026-08-13T18:05:00.000Z" })).toThrow("currently valid");
    expect(() => verify({ expectedOperation: "download" })).toThrow("does not match");
  });
});
