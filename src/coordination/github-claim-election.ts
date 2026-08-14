import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type { HostEnrollments } from "../security/host-enrollment.js";
import { canonicalJson } from "../security/canonical-json.js";
import { hostPublicKeyFingerprint } from "../security/host-envelope.js";

export const DISPATCHER_CLAIM_MARKER = "aubtown-dispatcher-claim:v1";
export const DISPATCHER_ELECTION_WINDOW_SECONDS = 30;
export const DISPATCHER_CLAIM_LEASE_SECONDS = 120;
const MAX_COMMENT_CLOCK_SKEW_SECONDS = 300;

const unsignedDispatcherClaimSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  sequence: z.number().int().positive().safe(),
  issuedAt: z.iso.datetime(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  issueNumber: z.number().int().positive().safe(),
  nonce: z.uuid(),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9_-]{43}$/u),
  electionWindowSeconds: z.literal(DISPATCHER_ELECTION_WINDOW_SECONDS),
  leaseSeconds: z.literal(DISPATCHER_CLAIM_LEASE_SECONDS),
});

export type UnsignedDispatcherClaim = z.infer<
  typeof unsignedDispatcherClaimSchema
>;
export type SignedDispatcherClaim = UnsignedDispatcherClaim & {
  readonly signatureBase64: string;
};

const signedDispatcherClaimSchema = unsignedDispatcherClaimSchema.extend({
  signatureBase64: z.string().min(1),
});

export interface GitHubClaimComment {
  readonly id: number;
  readonly body: string | null;
  readonly authorLogin: string | null;
  readonly createdAt: string;
}

export interface ValidDispatcherClaim {
  readonly commentId: number;
  readonly createdAt: string;
  readonly envelope: SignedDispatcherClaim;
}

export type DispatcherElection =
  | {
      readonly state: "none";
      readonly validClaims: readonly ValidDispatcherClaim[];
    }
  | {
      readonly state: "collecting" | "elected";
      readonly validClaims: readonly ValidDispatcherClaim[];
      readonly roundClaims: readonly ValidDispatcherClaim[];
      readonly roundStartedAt: string;
      readonly collectingUntil: string;
      readonly expiresAt: string;
      readonly winner: ValidDispatcherClaim;
    };

export type DispatcherLaunchConfirmation =
  | {
      readonly allowed: true;
      readonly winner: ValidDispatcherClaim;
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "collection-incomplete"
        | "claim-lost"
        | "winner-changed";
    };

const BLOCK_PATTERN = new RegExp(
  `<!-- ${DISPATCHER_CLAIM_MARKER}\\n([A-Za-z0-9_-]+)\\n-->`,
  "u",
);

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function assertEd25519(key: KeyObject, purpose: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${purpose} must be an Ed25519 key.`);
  }
  return key;
}

function unsigned(claim: SignedDispatcherClaim): UnsignedDispatcherClaim {
  const { signatureBase64: _signature, ...body } = claim;
  return unsignedDispatcherClaimSchema.parse(body);
}

export function signDispatcherClaim(
  claim: UnsignedDispatcherClaim,
  privateKeyPem: string,
): SignedDispatcherClaim {
  const parsed = unsignedDispatcherClaimSchema.parse(claim);
  const key = assertEd25519(
    createPrivateKey(privateKeyPem),
    "Dispatcher private key",
  );
  return {
    ...parsed,
    signatureBase64: sign(null, canonicalJson(parsed), key).toString("base64"),
  };
}

function parseSignedDispatcherClaim(value: unknown): SignedDispatcherClaim {
  return signedDispatcherClaimSchema.parse(value);
}

function verifyDispatcherClaim(
  claim: SignedDispatcherClaim,
  publicKeyPem: string,
): boolean {
  const key = assertEd25519(
    createPublicKey(publicKeyPem),
    "Dispatcher public key",
  );
  return verify(
    null,
    canonicalJson(unsigned(claim)),
    key,
    Buffer.from(claim.signatureBase64, "base64"),
  );
}

export function buildDispatcherClaimComment(
  envelope: SignedDispatcherClaim,
): string {
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return [
    "(AI Generated).",
    "",
    `<!-- ${DISPATCHER_CLAIM_MARKER}`,
    encoded,
    "-->",
    "AubTown dispatcher claim proposal.",
    `Host: ${envelope.hostId}`,
    `Host key: ${envelope.hostKeyFingerprint}`,
    `Nonce: ${envelope.nonce}`,
    `Election window: ${envelope.electionWindowSeconds.toLocaleString()} seconds`,
    `Lease: ${envelope.leaseSeconds.toLocaleString()} seconds`,
  ].join("\n");
}

export function parseDispatcherClaimComment(input: {
  readonly comment: GitHubClaimComment;
  readonly repository: string;
  readonly issueNumber: number;
  readonly machineAuthorLogin: string;
  readonly hostEnrollments: HostEnrollments;
}): ValidDispatcherClaim | undefined {
  if (
    input.comment.authorLogin !== input.machineAuthorLogin ||
    input.comment.body === null ||
    !input.comment.body.startsWith("(AI Generated).\n\n") ||
    !Number.isSafeInteger(input.comment.id) ||
    input.comment.id < 1 ||
    !Number.isFinite(Date.parse(input.comment.createdAt))
  ) {
    return undefined;
  }
  const encoded = BLOCK_PATTERN.exec(input.comment.body)?.[1];
  if (encoded === undefined) {
    return undefined;
  }
  let envelope: SignedDispatcherClaim;
  try {
    envelope = parseSignedDispatcherClaim(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
  if (
    envelope.repository !== input.repository ||
    envelope.issueNumber !== input.issueNumber ||
    envelope.electionWindowSeconds !== DISPATCHER_ELECTION_WINDOW_SECONDS ||
    envelope.leaseSeconds !== DISPATCHER_CLAIM_LEASE_SECONDS ||
    Math.abs(Date.parse(envelope.issuedAt) - Date.parse(input.comment.createdAt)) >
      MAX_COMMENT_CLOCK_SKEW_SECONDS * 1_000
  ) {
    return undefined;
  }
  const enrollment = input.hostEnrollments[envelope.hostId];
  if (
    enrollment === undefined ||
    !enrollment.enabled ||
    envelope.hostKeyFingerprint !==
      hostPublicKeyFingerprint(enrollment.publicKeyPem) ||
    !verifyDispatcherClaim(envelope, enrollment.publicKeyPem)
  ) {
    return undefined;
  }
  return {
    commentId: input.comment.id,
    createdAt: new Date(input.comment.createdAt).toISOString(),
    envelope,
  };
}

function partitionRounds(
  claims: readonly ValidDispatcherClaim[],
): readonly (readonly ValidDispatcherClaim[])[] {
  const rounds: ValidDispatcherClaim[][] = [];
  for (const claim of claims) {
    const current = rounds.at(-1);
    if (current === undefined) {
      rounds.push([claim]);
      continue;
    }
    const anchor = current[0];
    if (
      anchor !== undefined &&
      Date.parse(claim.createdAt) <=
        Date.parse(anchor.createdAt) + DISPATCHER_ELECTION_WINDOW_SECONDS * 1_000
    ) {
      current.push(claim);
    } else {
      rounds.push([claim]);
    }
  }
  return rounds;
}

export function electDispatcherClaim(input: {
  readonly comments: readonly GitHubClaimComment[];
  readonly repository: string;
  readonly issueNumber: number;
  readonly machineAuthorLogin: string;
  readonly hostEnrollments: HostEnrollments;
  readonly observedAt: string;
}): DispatcherElection {
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error("Dispatcher election observation time must be valid.");
  }
  const validClaims = input.comments
    .map((comment) =>
      parseDispatcherClaimComment({
        comment,
        repository: input.repository,
        issueNumber: input.issueNumber,
        machineAuthorLogin: input.machineAuthorLogin,
        hostEnrollments: input.hostEnrollments,
      }),
    )
    .filter((claim): claim is ValidDispatcherClaim => claim !== undefined)
    .filter((claim) => Date.parse(claim.createdAt) <= observedAtMs)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.commentId - right.commentId,
    );
  const activeRound = partitionRounds(validClaims).find((round) => {
    const anchor = round[0];
    return (
      anchor !== undefined &&
      Date.parse(anchor.createdAt) + DISPATCHER_CLAIM_LEASE_SECONDS * 1_000 > observedAtMs
    );
  });
  const anchor = activeRound?.[0];
  if (activeRound === undefined || anchor === undefined) {
    return { state: "none", validClaims };
  }
  const roundClaims = [...activeRound].sort(
    (left, right) => left.commentId - right.commentId,
  );
  const winner = roundClaims[0];
  if (winner === undefined) {
    return { state: "none", validClaims };
  }
  const collectingUntil = addSeconds(
    anchor.createdAt,
    DISPATCHER_ELECTION_WINDOW_SECONDS,
  );
  return {
    state: observedAtMs < Date.parse(collectingUntil) ? "collecting" : "elected",
    validClaims,
    roundClaims,
    roundStartedAt: anchor.createdAt,
    collectingUntil,
    expiresAt: addSeconds(anchor.createdAt, DISPATCHER_CLAIM_LEASE_SECONDS),
    winner,
  };
}

export function confirmDispatcherLaunch(input: {
  readonly collectionRead: DispatcherElection;
  readonly prelaunchRead: DispatcherElection;
  readonly ownCommentId: number;
}): DispatcherLaunchConfirmation {
  if (
    input.collectionRead.state !== "elected" ||
    input.prelaunchRead.state !== "elected"
  ) {
    return { allowed: false, reason: "collection-incomplete" };
  }
  if (input.collectionRead.winner.commentId !== input.ownCommentId) {
    return { allowed: false, reason: "claim-lost" };
  }
  if (
    input.prelaunchRead.winner.commentId !==
    input.collectionRead.winner.commentId
  ) {
    return { allowed: false, reason: "winner-changed" };
  }
  return { allowed: true, winner: input.prelaunchRead.winner };
}
