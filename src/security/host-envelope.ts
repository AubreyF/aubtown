import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type { HostHeartbeat } from "../domain/host.js";
import type { RawAccountUsageObservation } from "../domain/types.js";
import { canonicalJson } from "./canonical-json.js";
import { checkpointGrantRequestSchema } from "../checkpoints/grant.js";
import {
  executorCommandReceiptSchema,
  executorReconcileRequestSchema,
} from "../execution/command.js";
import { signedCheckpointStorageReceiptSchema } from "../checkpoints/receipt.js";
import { custodyRestoreReceiptSchema } from "../execution/restore.js";
import { initialWorkspaceReceiptSchema } from "../execution/workspace.js";
import {
  exactValidationReceiptSchema,
  independentReviewReceiptSchema,
} from "../adjudication/receipts.js";

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const heartbeatSchema: z.ZodType<HostHeartbeat> = z.object({
  hostId: z.string().regex(HOST_ID),
  lane: z.enum(["linux", "macos"]),
  observedAt: z.iso.datetime(),
  activeClaims: z.array(z.string().min(1)),
  accountIds: z.array(z.string().min(1)),
});

const usageObservationSchema: z.ZodType<RawAccountUsageObservation> = z.object({
  accountId: z.string().min(1),
  observedAt: z.iso.datetime(),
  primary: z.object({
    usedPercent: z.number().min(0).max(100),
    windowDurationMinutes: z.number().positive(),
    resetsAt: z.iso.datetime(),
  }),
  activeTurnIds: z.array(z.string().min(1)),
});

const unsignedEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("heartbeat"),
    payload: heartbeatSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("quota-observation"),
    payload: z.object({
      observation: usageObservationSchema,
    }),
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("checkpoint-grant"),
    payload: checkpointGrantRequestSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("executor-poll"),
    payload: z.object({
      accountId: z.string().min(1),
    }),
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("executor-receipt"),
    payload: executorCommandReceiptSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("executor-reconcile"),
    payload: executorReconcileRequestSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("checkpoint-receipt"),
    payload: signedCheckpointStorageReceiptSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("restore-poll"),
    payload: z.object({}),
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("restore-receipt"),
    payload: custodyRestoreReceiptSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("workspace-poll"),
    payload: z.object({}),
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("workspace-receipt"),
    payload: initialWorkspaceReceiptSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("adjudication-poll"),
    payload: z.object({
      accountId: z.string().min(1),
      reviewerDriverId: z.literal("codex-app-server-review-v1"),
    }),
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("validation-receipt"),
    payload: exactValidationReceiptSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    hostId: z.string().regex(HOST_ID),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("review-receipt"),
    payload: independentReviewReceiptSchema,
  }),
]);

export type UnsignedHostEnvelope = z.infer<typeof unsignedEnvelopeSchema>;
export type SignedHostEnvelope = UnsignedHostEnvelope & {
  readonly signatureBase64: string;
};

const signedEnvelopeSchema = z.intersection(
  unsignedEnvelopeSchema,
  z.object({ signatureBase64: z.string().min(1) }),
);

function assertEd25519(key: KeyObject, purpose: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${purpose} must be an Ed25519 key.`);
  }
  return key;
}

function unsigned(envelope: SignedHostEnvelope): UnsignedHostEnvelope {
  const { signatureBase64: _signature, ...body } = envelope;
  return unsignedEnvelopeSchema.parse(body);
}

export function parseSignedHostEnvelope(value: unknown): SignedHostEnvelope {
  return signedEnvelopeSchema.parse(value) as SignedHostEnvelope;
}

export function signHostEnvelope(
  envelope: UnsignedHostEnvelope,
  privateKeyPem: string,
): SignedHostEnvelope {
  const parsed = unsignedEnvelopeSchema.parse(envelope);
  const key = assertEd25519(createPrivateKey(privateKeyPem), "Host private key");
  return {
    ...parsed,
    signatureBase64: sign(null, canonicalJson(parsed), key).toString("base64"),
  };
}

export function verifyHostEnvelope(
  envelope: SignedHostEnvelope,
  publicKeyPem: string,
): boolean {
  const key = assertEd25519(createPublicKey(publicKeyPem), "Host public key");
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  return verify(null, canonicalJson(unsigned(envelope)), key, signature);
}

export function hostEnvelopeDigest(envelope: SignedHostEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

export function hostPublicKeyFingerprint(publicKeyPem: string): string {
  const key = assertEd25519(createPublicKey(publicKeyPem), "Host public key");
  const der = key.export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64url")}`;
}
