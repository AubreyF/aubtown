import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../security/canonical-json.js";

const unsignedProofSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().min(1),
  grantNonce: z.uuid(),
  method: z.enum(["PUT", "GET"]),
  path: z.string().startsWith("/v1/checkpoints/"),
  bodyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  requestedAt: z.iso.datetime(),
});

export type UnsignedCheckpointProof = z.infer<typeof unsignedProofSchema>;
export type SignedCheckpointProof = UnsignedCheckpointProof & {
  readonly signatureBase64: string;
};

const signedProofSchema = z.intersection(
  unsignedProofSchema,
  z.object({ signatureBase64: z.string().min(1) }),
);

function assertEd25519(key: KeyObject, purpose: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${purpose} must be an Ed25519 key.`);
  }
  return key;
}

function unsigned(proof: SignedCheckpointProof): UnsignedCheckpointProof {
  const { signatureBase64: _signature, ...body } = proof;
  return unsignedProofSchema.parse(body);
}

export function signCheckpointProof(
  proof: UnsignedCheckpointProof,
  privateKeyPem: string,
): SignedCheckpointProof {
  const parsed = unsignedProofSchema.parse(proof);
  const key = assertEd25519(createPrivateKey(privateKeyPem), "Host proof private key");
  return {
    ...parsed,
    signatureBase64: sign(null, canonicalJson(parsed), key).toString("base64"),
  };
}

export function parseSignedCheckpointProof(value: unknown): SignedCheckpointProof {
  return signedProofSchema.parse(value) as SignedCheckpointProof;
}

export function verifyCheckpointProof(input: {
  readonly proof: SignedCheckpointProof;
  readonly publicKeyPem: string;
  readonly now: string;
  readonly expectedHostId: string;
  readonly expectedGrantNonce: string;
  readonly expectedMethod: "PUT" | "GET";
  readonly expectedPath: string;
}): SignedCheckpointProof {
  const proof = parseSignedCheckpointProof(input.proof);
  const key = assertEd25519(createPublicKey(input.publicKeyPem), "Host proof public key");
  if (
    !verify(
      null,
      canonicalJson(unsigned(proof)),
      key,
      Buffer.from(proof.signatureBase64, "base64"),
    )
  ) {
    throw new Error("Checkpoint request proof signature is invalid.");
  }
  const nowMs = Date.parse(input.now);
  const requestedAtMs = Date.parse(proof.requestedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(requestedAtMs) ||
    Math.abs(nowMs - requestedAtMs) > 120_000
  ) {
    throw new Error("Checkpoint request proof timestamp is stale.");
  }
  if (
    proof.hostId !== input.expectedHostId ||
    proof.grantNonce !== input.expectedGrantNonce ||
    proof.method !== input.expectedMethod ||
    proof.path !== input.expectedPath
  ) {
    throw new Error("Checkpoint request proof does not match its operation.");
  }
  return proof;
}

export function encodeCheckpointAuthorization(grant: unknown): string {
  return Buffer.from(JSON.stringify(grant)).toString("base64url");
}

export function decodeCheckpointAuthorization(value: string): unknown {
  if (value.length === 0 || value.length > 16_384) {
    throw new Error("Checkpoint authorization header is invalid.");
  }
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
