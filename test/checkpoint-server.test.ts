import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { checkpointReference, encodeCheckpoint } from "../src/checkpoints/codec.js";
import { CheckpointGrantIssuer } from "../src/checkpoints/grant.js";
import { LocalCheckpointStore } from "../src/checkpoints/local-store.js";
import {
  encodeCheckpointAuthorization,
  signCheckpointProof,
} from "../src/checkpoints/proof.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { createCheckpointServer } from "../src/gateway/checkpoint-server.js";
import { CheckpointTransferClient } from "../src/clients/checkpoint-transfer.js";
import { claim } from "./helpers.js";

const roots: string[] = [];
const servers: ReturnType<typeof createCheckpointServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("checkpoint transfer edge", () => {
  it("moves encrypted unpublished work from a Mac identity to the next Linux custody epoch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "freedworks-checkpoint-edge-"));
    roots.push(root);
    const grantKeys = keys();
    const macKeys = keys();
    const linuxKeys = keys();
    const store = new LocalCheckpointStore(path.join(root, "shared-store"));
    const clock = new Date("2026-08-13T18:00:00.000Z");
    const server = createCheckpointServer({
      store,
      grantPublicKeyPem: grantKeys.publicKey,
      hostEnrollments: {
        "macos-executor-1": {
          enabled: true,
          lane: "macos",
          accountIds: ["codex-pro-1"],
          publicKeyPem: macKeys.publicKey,
        },
        "linux-control-1": {
          enabled: true,
          lane: "linux",
          accountIds: ["codex-pro-1"],
          publicKeyPem: linuxKeys.publicKey,
        },
      },
      now: () => clock,
      onDenial: () => undefined,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Checkpoint edge did not bind a port.");
    }
    const baseUrl = `http://127.0.0.1:${address.port.toLocaleString("en-US", { useGrouping: false })}`;

    const originalClaim = claim({ hostId: "macos-executor-1" });
    const archive = new TextEncoder().encode("encrypted unpublished branch state");
    const key = randomBytes(32);
    const cipher = new XChaChaCheckpointCipher(
      { resolve: async () => key },
      () => new Uint8Array(24).fill(5),
    );
    const encrypted = await cipher.encrypt({
      manifest: createCheckpointManifest({
        claim: originalClaim,
        repositoryHead: "a".repeat(40),
        baseHead: "b".repeat(40),
        patch: archive,
        includedUntrackedPaths: [],
        validationReceipts: ["focused-test:passed"],
        createdAt: clock.toISOString(),
      }),
      archive,
      keyReference: "keyring:checkpoint-v1",
    });
    const encoded = encodeCheckpoint(encrypted);
    const reference = checkpointReference(encoded);
    const issuer = new CheckpointGrantIssuer(
      grantKeys.privateKey,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const uploadGrant = issuer.issue({
      currentClaim: originalClaim,
      requestingHostId: "macos-executor-1",
      request: {
        repository: originalClaim.repository,
        issueNumber: originalClaim.issueNumber,
        claimId: originalClaim.claimId,
        custodyEpoch: 1,
        checkpointEpoch: 1,
        operation: "upload",
        reference,
        contentLength: encoded.length,
      },
      issuedAt: clock.toISOString(),
    });
    const macClient = new CheckpointTransferClient(
      baseUrl,
      "macos-executor-1",
      macKeys.privateKey,
      fetch,
      () => clock,
    );
    await expect(macClient.upload(encrypted, uploadGrant)).resolves.toBe(reference);

    const transferredClaim = {
      ...originalClaim,
      custodyEpoch: 2,
      hostId: "linux-control-1",
      workerId: "linux-worker-1",
    };
    const downloadGrant = new CheckpointGrantIssuer(
      grantKeys.privateKey,
      () => "22222222-2222-4222-8222-222222222222",
    ).issue({
      currentClaim: transferredClaim,
      requestingHostId: "linux-control-1",
      request: {
        repository: originalClaim.repository,
        issueNumber: originalClaim.issueNumber,
        claimId: originalClaim.claimId,
        custodyEpoch: 2,
        checkpointEpoch: 1,
        operation: "download",
        reference,
        contentLength: encoded.length,
      },
      issuedAt: clock.toISOString(),
    });
    const linuxClient = new CheckpointTransferClient(
      baseUrl,
      "linux-control-1",
      linuxKeys.privateKey,
      fetch,
      () => clock,
    );
    const downloaded = await linuxClient.download(downloadGrant);
    await expect(cipher.decrypt(downloaded)).resolves.toEqual(archive);
  });

  it("rejects a transfer proof from a different host identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "freedworks-checkpoint-edge-"));
    roots.push(root);
    const grantKeys = keys();
    const macKeys = keys();
    const linuxKeys = keys();
    const server = createCheckpointServer({
      store: new LocalCheckpointStore(path.join(root, "store")),
      grantPublicKeyPem: grantKeys.publicKey,
      hostEnrollments: {
        "macos-executor-1": {
          enabled: true,
          lane: "macos",
          accountIds: [],
          publicKeyPem: macKeys.publicKey,
        },
      },
      now: () => new Date("2026-08-13T18:00:00.000Z"),
      onDenial: () => undefined,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Checkpoint edge did not bind a port.");
    }
    const currentClaim = claim({ hostId: "macos-executor-1" });
    const reference = "a".repeat(64);
    const grant = new CheckpointGrantIssuer(grantKeys.privateKey).issue({
      currentClaim,
      requestingHostId: "macos-executor-1",
      request: {
        repository: currentClaim.repository,
        issueNumber: currentClaim.issueNumber,
        claimId: currentClaim.claimId,
        custodyEpoch: 1,
        checkpointEpoch: 1,
        operation: "upload",
        reference,
        contentLength: 1,
      },
      issuedAt: "2026-08-13T18:00:00.000Z",
    });
    const proof = signCheckpointProof(
      {
        schemaVersion: 1,
        hostId: "macos-executor-1",
        grantNonce: grant.nonce,
        method: "PUT",
        path: `/v1/checkpoints/${reference}`,
        bodyDigest: reference,
        requestedAt: "2026-08-13T18:00:00.000Z",
      },
      linuxKeys.privateKey,
    );
    const response = await fetch(
      `http://127.0.0.1:${address.port.toLocaleString("en-US", { useGrouping: false })}/v1/checkpoints/${reference}`,
      {
        method: "PUT",
        headers: {
          authorization: `FreedworksGrant ${encodeCheckpointAuthorization(grant)}`,
          "x-freedworks-host-proof": encodeCheckpointAuthorization(proof),
          "content-length": "1",
        },
        body: new Uint8Array([1]),
      },
    );
    expect(response.status).toBe(403);
  });
});
