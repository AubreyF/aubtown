import { createHash } from "node:crypto";
import { z } from "zod";
import type { CustodyCheckpoint } from "../domain/types.js";
import type { EncryptedCheckpointPayload } from "./store.js";

export const MAX_STORED_CHECKPOINT_BYTES = 512 * 1024 * 1024;
export const CHECKPOINT_REFERENCE_PATTERN = /^[0-9a-f]{64}$/u;

const manifestSchema: z.ZodType<CustodyCheckpoint> = z.object({
  schemaVersion: z.literal(1),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  sourceHostId: z.string().min(1),
  repositoryHead: z.string().regex(/^[0-9a-f]{40}$/u),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  patchDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  includedUntrackedPaths: z.array(z.string()),
  validationReceipts: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

const storedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: manifestSchema,
  ciphertextBase64: z.string(),
  nonceBase64: z.string(),
  algorithm: z.literal("xchacha20-poly1305"),
  keyReference: z.string().min(1),
});

export function encodeCheckpoint(payload: EncryptedCheckpointPayload): Uint8Array {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({
      schemaVersion: 1,
      manifest: payload.manifest,
      ciphertextBase64: Buffer.from(payload.ciphertext).toString("base64"),
      nonceBase64: Buffer.from(payload.nonce).toString("base64"),
      algorithm: payload.algorithm,
      keyReference: payload.keyReference,
    })}\n`,
  );
  if (bytes.length > MAX_STORED_CHECKPOINT_BYTES) {
    throw new Error("Encrypted checkpoint exceeds the store size limit.");
  }
  return bytes;
}

export function decodeCheckpoint(bytes: Uint8Array): EncryptedCheckpointPayload {
  if (bytes.length > MAX_STORED_CHECKPOINT_BYTES) {
    throw new Error("Stored checkpoint exceeds the store size limit.");
  }
  const parsed = storedPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  return {
    manifest: parsed.manifest,
    ciphertext: Buffer.from(parsed.ciphertextBase64, "base64"),
    nonce: Buffer.from(parsed.nonceBase64, "base64"),
    algorithm: parsed.algorithm,
    keyReference: parsed.keyReference,
  };
}

export function checkpointReference(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertCheckpointReference(reference: string): void {
  if (!CHECKPOINT_REFERENCE_PATTERN.test(reference)) {
    throw new Error("Checkpoint reference must be a lowercase SHA-256 digest.");
  }
}
