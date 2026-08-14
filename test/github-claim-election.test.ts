import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDispatcherClaimComment,
  confirmDispatcherLaunch,
  electDispatcherClaim,
  signDispatcherClaim,
  type GitHubClaimComment,
} from "../src/coordination/github-claim-election.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";
import { hostPublicKeyFingerprint } from "../src/security/host-envelope.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const first = keys();
const second = keys();
const enrollments: HostEnrollments = {
  "linux-dispatcher-1": {
    enabled: true,
    lane: "linux",
    accountIds: ["subscription-1"],
    publicKeyPem: first.publicKey,
  },
  "linux-dispatcher-2": {
    enabled: true,
    lane: "linux",
    accountIds: ["subscription-1"],
    publicKeyPem: second.publicKey,
  },
};

function claim(input: {
  readonly id: number;
  readonly hostId: keyof typeof enrollments;
  readonly createdAt: string;
  readonly nonce: string;
}): GitHubClaimComment {
  const key = input.hostId === "linux-dispatcher-1" ? first : second;
  const envelope = signDispatcherClaim(
    {
      schemaVersion: 1,
      hostId: input.hostId,
      sequence: input.id,
      issuedAt: input.createdAt,
      repository: "freed-project/freed",
      issueNumber: 1_234,
      nonce: input.nonce,
      hostKeyFingerprint: hostPublicKeyFingerprint(key.publicKey),
      electionWindowSeconds: 30,
      leaseSeconds: 120,
    },
    key.privateKey,
  );
  return {
    id: input.id,
    authorLogin: "aubtown-coordinator[bot]",
    createdAt: input.createdAt,
    body: buildDispatcherClaimComment(envelope),
  };
}

function elect(comments: readonly GitHubClaimComment[], observedAt: string) {
  return electDispatcherClaim({
    comments,
    repository: "freed-project/freed",
    issueNumber: 1_234,
    machineAuthorLogin: "aubtown-coordinator[bot]",
    hostEnrollments: enrollments,
    observedAt,
  });
}

describe("GitHub dispatcher claim election", () => {
  it("waits for the collection window and elects the lowest GitHub comment ID", () => {
    const comments = [
      claim({
        id: 102,
        hostId: "linux-dispatcher-2",
        createdAt: "2026-08-13T18:00:02.000Z",
        nonce: "22222222-2222-4222-8222-222222222222",
      }),
      claim({
        id: 101,
        hostId: "linux-dispatcher-1",
        createdAt: "2026-08-13T18:00:01.000Z",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
    ];
    expect(elect(comments, "2026-08-13T18:00:20.000Z")).toMatchObject({
      state: "collecting",
      winner: { commentId: 101 },
    });
    expect(elect([...comments].reverse(), "2026-08-13T18:00:31.000Z")).toMatchObject({
      state: "elected",
      winner: {
        commentId: 101,
        envelope: { hostId: "linux-dispatcher-1" },
      },
    });
  });

  it("produces the same winner for every conforming dispatcher", () => {
    const comments = [
      claim({
        id: 501,
        hostId: "linux-dispatcher-1",
        createdAt: "2026-08-13T18:00:00.000Z",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
      claim({
        id: 502,
        hostId: "linux-dispatcher-2",
        createdAt: "2026-08-13T18:00:05.000Z",
        nonce: "22222222-2222-4222-8222-222222222222",
      }),
    ];
    const left = elect(comments, "2026-08-13T18:00:31.000Z");
    const right = elect([...comments].reverse(), "2026-08-13T18:00:31.000Z");
    expect(left).toMatchObject({ state: "elected", winner: { commentId: 501 } });
    expect(right).toMatchObject({ state: "elected", winner: { commentId: 501 } });
  });

  it("ignores spoofed authors, signatures, and host fingerprints", () => {
    const valid = claim({
      id: 201,
      hostId: "linux-dispatcher-1",
      createdAt: "2026-08-13T18:00:00.000Z",
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    const spoofedAuthor = { ...valid, id: 1, authorLogin: "human" };
    const tampered = {
      ...valid,
      id: 2,
      body:
        valid.body?.replace(
          /(aubtown-dispatcher-claim:v1\n)([A-Za-z0-9_-])/u,
          (_match, prefix: string, firstCharacter: string) =>
            `${prefix}${firstCharacter === "A" ? "B" : "A"}`,
        ) ?? null,
    };
    expect(
      elect([spoofedAuthor, tampered, valid], "2026-08-13T18:00:31.000Z"),
    ).toMatchObject({
      state: "elected",
      validClaims: [{ commentId: 201 }],
      winner: { commentId: 201 },
    });
  });

  it("expires a dead winner and advances to the next comment round", () => {
    const comments = [
      claim({
        id: 301,
        hostId: "linux-dispatcher-1",
        createdAt: "2026-08-13T18:00:00.000Z",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
      claim({
        id: 401,
        hostId: "linux-dispatcher-2",
        createdAt: "2026-08-13T18:03:00.000Z",
        nonce: "22222222-2222-4222-8222-222222222222",
      }),
    ];
    expect(elect(comments, "2026-08-13T18:03:31.000Z")).toMatchObject({
      state: "elected",
      winner: { commentId: 401 },
    });
  });

  it("requires the same winning claim on the collection and prelaunch reads", () => {
    const firstClaim = claim({
      id: 701,
      hostId: "linux-dispatcher-1",
      createdAt: "2026-08-13T18:00:00.000Z",
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    const collectionRead = elect(
      [firstClaim],
      "2026-08-13T18:00:31.000Z",
    );
    const prelaunchRead = elect(
      [
        firstClaim,
        claim({
          id: 700,
          hostId: "linux-dispatcher-2",
          createdAt: "2026-08-13T18:00:01.000Z",
          nonce: "22222222-2222-4222-8222-222222222222",
        }),
      ],
      "2026-08-13T18:00:32.000Z",
    );
    expect(
      confirmDispatcherLaunch({
        collectionRead,
        prelaunchRead,
        ownCommentId: 701,
      }),
    ).toEqual({ allowed: false, reason: "winner-changed" });
    expect(
      confirmDispatcherLaunch({
        collectionRead,
        prelaunchRead: collectionRead,
        ownCommentId: 701,
      }),
    ).toMatchObject({ allowed: true, winner: { commentId: 701 } });
  });

  it("rejects a signed claim replayed into another issue or much later", () => {
    const valid = claim({
      id: 801,
      hostId: "linux-dispatcher-1",
      createdAt: "2026-08-13T18:00:00.000Z",
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    expect(
      electDispatcherClaim({
        comments: [valid],
        repository: "freed-project/freed",
        issueNumber: 9_999,
        machineAuthorLogin: "aubtown-coordinator[bot]",
        hostEnrollments: enrollments,
        observedAt: "2026-08-13T18:00:31.000Z",
      }),
    ).toEqual({ state: "none", validClaims: [] });
    expect(
      elect(
        [{ ...valid, createdAt: "2026-08-13T19:00:00.000Z" }],
        "2026-08-13T19:00:31.000Z",
      ),
    ).toEqual({ state: "none", validClaims: [] });
  });

  it("uses an AI-prefixed immutable comment body", () => {
    const comment = claim({
      id: 601,
      hostId: "linux-dispatcher-1",
      createdAt: "2026-08-13T18:00:00.000Z",
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    expect(comment.body?.startsWith("(AI Generated).\n\n")).toBe(true);
    expect(comment.body).toContain("aubtown-dispatcher-claim:v1");
    expect(comment.body).toContain("Election window: 30 seconds");
  });
});
