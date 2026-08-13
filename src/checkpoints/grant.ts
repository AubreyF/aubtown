import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type { DispatchClaim, RepositoryRef } from "../domain/types.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  assertCheckpointReference,
  MAX_STORED_CHECKPOINT_BYTES,
} from "./codec.js";

const GRANT_LIFETIME_SECONDS = 300;

const repositorySchema: z.ZodType<RepositoryRef> = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const checkpointGrantRequestSchema = z.object({
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  checkpointEpoch: z.number().int().positive(),
  operation: z.enum(["upload", "download"]),
  reference: z.string().regex(/^[0-9a-f]{64}$/u),
  contentLength: z.number().int().positive().max(MAX_STORED_CHECKPOINT_BYTES),
});

export type CheckpointGrantRequest = z.infer<typeof checkpointGrantRequestSchema>;

const unsignedGrantSchema = checkpointGrantRequestSchema.extend({
  schemaVersion: z.literal(1),
  hostId: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  nonce: z.uuid(),
});

export type UnsignedCheckpointGrant = z.infer<typeof unsignedGrantSchema>;
export type SignedCheckpointGrant = UnsignedCheckpointGrant & {
  readonly signatureBase64: string;
};

const signedGrantSchema = z.intersection(
  unsignedGrantSchema,
  z.object({ signatureBase64: z.string().min(1) }),
);

function assertEd25519(key: KeyObject, purpose: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${purpose} must be an Ed25519 key.`);
  }
  return key;
}

function unsigned(grant: SignedCheckpointGrant): UnsignedCheckpointGrant {
  const { signatureBase64: _signature, ...body } = grant;
  return unsignedGrantSchema.parse(body);
}

export function parseSignedCheckpointGrant(value: unknown): SignedCheckpointGrant {
  return signedGrantSchema.parse(value) as SignedCheckpointGrant;
}

export class CheckpointGrantIssuer {
  readonly #privateKey: KeyObject;

  constructor(
    privateKeyPem: string,
    private readonly nonceSource: () => string = randomUUID,
  ) {
    this.#privateKey = assertEd25519(
      createPrivateKey(privateKeyPem),
      "Checkpoint grant private key",
    );
  }

  issue(input: {
    readonly currentClaim: DispatchClaim;
    readonly requestingHostId: string;
    readonly request: CheckpointGrantRequest;
    readonly issuedAt: string;
  }): SignedCheckpointGrant {
    const request = checkpointGrantRequestSchema.parse(input.request);
    assertCheckpointRequestAuthority({
      currentClaim: input.currentClaim,
      requestingHostId: input.requestingHostId,
      request,
    });
    const issuedAtMs = Date.parse(input.issuedAt);
    if (!Number.isFinite(issuedAtMs)) {
      throw new Error("Checkpoint grant issue time is invalid.");
    }
    const grant: UnsignedCheckpointGrant = {
      schemaVersion: 1,
      ...request,
      hostId: input.requestingHostId,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + GRANT_LIFETIME_SECONDS * 1_000).toISOString(),
      nonce: this.nonceSource(),
    };
    return {
      ...grant,
      signatureBase64: sign(null, canonicalJson(grant), this.#privateKey).toString("base64"),
    };
  }
}

export function verifyCheckpointGrant(input: {
  readonly grant: SignedCheckpointGrant;
  readonly publicKeyPem: string;
  readonly now: string;
  readonly expectedHostId: string;
  readonly expectedOperation: "upload" | "download";
  readonly expectedReference: string;
  readonly expectedContentLength: number;
}): void {
  const grant = parseSignedCheckpointGrant(input.grant);
  const key = assertEd25519(
    createPublicKey(input.publicKeyPem),
    "Checkpoint grant public key",
  );
  if (
    !verify(
      null,
      canonicalJson(unsigned(grant)),
      key,
      Buffer.from(grant.signatureBase64, "base64"),
    )
  ) {
    throw new Error("Checkpoint transfer grant signature is invalid.");
  }
  const nowMs = Date.parse(input.now);
  const issuedAtMs = Date.parse(grant.issuedAt);
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error("Checkpoint transfer grant time is invalid.");
  }
  if (
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > GRANT_LIFETIME_SECONDS * 1_000
  ) {
    throw new Error("Checkpoint transfer grant lifetime is invalid.");
  }
  if (nowMs < issuedAtMs - 120_000 || nowMs >= expiresAtMs) {
    throw new Error("Checkpoint transfer grant is not currently valid.");
  }
  assertCheckpointReference(input.expectedReference);
  if (
    grant.hostId !== input.expectedHostId ||
    grant.operation !== input.expectedOperation ||
    grant.reference !== input.expectedReference ||
    grant.contentLength !== input.expectedContentLength
  ) {
    throw new Error("Checkpoint transfer grant does not match the requested operation.");
  }
}

export function assertCheckpointRequestAuthority(input: {
  readonly currentClaim: DispatchClaim;
  readonly requestingHostId: string;
  readonly request: CheckpointGrantRequest;
}): void {
  const request = checkpointGrantRequestSchema.parse(input.request);
  const claim = input.currentClaim;
  if (
    claim.repository.owner !== request.repository.owner ||
    claim.repository.name !== request.repository.name ||
    claim.repository.defaultBranch !== request.repository.defaultBranch ||
    claim.issueNumber !== request.issueNumber ||
    claim.claimId !== request.claimId ||
    claim.custodyEpoch !== request.custodyEpoch ||
    claim.hostId !== input.requestingHostId
  ) {
    throw new Error("Checkpoint transfer request does not match current claim custody.");
  }
  if (
    (request.operation === "upload" && request.checkpointEpoch !== claim.custodyEpoch) ||
    (request.operation === "download" &&
      request.checkpointEpoch !== claim.custodyEpoch &&
      request.checkpointEpoch + 1 !== claim.custodyEpoch)
  ) {
    throw new Error("Checkpoint object epoch is incompatible with current claim custody.");
  }
}
