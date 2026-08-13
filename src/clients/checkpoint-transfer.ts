import { createHash } from "node:crypto";
import type { EncryptedCheckpointPayload } from "../checkpoints/store.js";
import {
  checkpointReference,
  decodeCheckpoint,
  encodeCheckpoint,
} from "../checkpoints/codec.js";
import type { SignedCheckpointGrant } from "../checkpoints/grant.js";
import {
  encodeCheckpointAuthorization,
  signCheckpointProof,
} from "../checkpoints/proof.js";

export class CheckpointTransferClient {
  constructor(
    private readonly edgeUrl: string,
    private readonly hostId: string,
    private readonly hostPrivateKeyPem: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upload(
    payload: EncryptedCheckpointPayload,
    grant: SignedCheckpointGrant,
  ): Promise<string> {
    const bytes = encodeCheckpoint(payload);
    const reference = checkpointReference(bytes);
    if (
      grant.operation !== "upload" ||
      grant.hostId !== this.hostId ||
      grant.reference !== reference ||
      grant.contentLength !== bytes.length
    ) {
      throw new Error("Checkpoint upload grant does not match the encrypted payload.");
    }
    const path = `/v1/checkpoints/${reference}`;
    const proof = signCheckpointProof(
      {
        schemaVersion: 1,
        hostId: this.hostId,
        grantNonce: grant.nonce,
        method: "PUT",
        path,
        bodyDigest: reference,
        requestedAt: this.now().toISOString(),
      },
      this.hostPrivateKeyPem,
    );
    const response = await this.fetchImpl(`${this.edgeUrl.replace(/\/$/u, "")}${path}`, {
      method: "PUT",
      headers: {
        authorization: `FreedworksGrant ${encodeCheckpointAuthorization(grant)}`,
        "x-freedworks-host-proof": encodeCheckpointAuthorization(proof),
        "content-type": "application/vnd.freedworks.checkpoint+json",
        "content-length": bytes.length.toLocaleString("en-US", { useGrouping: false }),
      },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(
        `Checkpoint edge returned ${response.status.toLocaleString("en-US", { useGrouping: false })} for upload.`,
      );
    }
    return reference;
  }

  async download(grant: SignedCheckpointGrant): Promise<EncryptedCheckpointPayload> {
    if (grant.operation !== "download" || grant.hostId !== this.hostId) {
      throw new Error("Checkpoint download grant does not match this host.");
    }
    const path = `/v1/checkpoints/${grant.reference}`;
    const proof = signCheckpointProof(
      {
        schemaVersion: 1,
        hostId: this.hostId,
        grantNonce: grant.nonce,
        method: "GET",
        path,
        bodyDigest: createHash("sha256").update(new Uint8Array()).digest("hex"),
        requestedAt: this.now().toISOString(),
      },
      this.hostPrivateKeyPem,
    );
    const response = await this.fetchImpl(`${this.edgeUrl.replace(/\/$/u, "")}${path}`, {
      headers: {
        authorization: `FreedworksGrant ${encodeCheckpointAuthorization(grant)}`,
        "x-freedworks-host-proof": encodeCheckpointAuthorization(proof),
      },
    });
    if (!response.ok) {
      throw new Error(
        `Checkpoint edge returned ${response.status.toLocaleString("en-US", { useGrouping: false })} for download.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== grant.contentLength || checkpointReference(bytes) !== grant.reference) {
      throw new Error("Checkpoint download does not match its content-addressed grant.");
    }
    return decodeCheckpoint(bytes);
  }
}
