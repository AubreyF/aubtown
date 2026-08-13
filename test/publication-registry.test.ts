import { describe, expect, it } from "vitest";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import {
  blockPublication,
  initializePublication,
  recordPublication,
} from "../src/orchestration/publication-registry.js";
import type { DraftPublicationReceipt } from "../src/publication/draft-publisher.js";
import type { PublicationPlan } from "../src/publication/policy.js";
import { claim, FREED_REPOSITORY } from "./helpers.js";

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  branch: claim().branch,
  worktree: claim().worktree,
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead: "a".repeat(40),
  head: "c".repeat(40),
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

const plan: PublicationPlan = {
  allowed: true,
  action: "create-draft",
  reasons: [],
  repository: "freed-project/freed",
  title: "fix: make validation deterministic",
  branch: workProduct.branch,
  head: workProduct.head,
  body: "(AI Generated).\n\nMakes validation deterministic.",
  workProduct,
};

const receipt: DraftPublicationReceipt = {
  schemaVersion: 1,
  repository: "freed-project/freed",
  checkpointReference: workProduct.checkpointReference,
  branch: workProduct.branch,
  head: workProduct.head,
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/freed-project/freed/pull/42",
  draft: true,
  publishedAt: "2026-08-13T18:02:00.000Z",
  tokenExpiresAt: "2026-08-13T19:00:00.000Z",
};

describe("publication registry", () => {
  it("persists one immutable plan and byte-equivalent publication receipt", () => {
    const planned = initializePublication(null, plan);
    expect(initializePublication(planned, plan)).toEqual(planned);
    const published = recordPublication(planned, receipt);
    expect(recordPublication(published, receipt)).toEqual(published);
    expect(published).toMatchObject({ stage: "published", receipt });
  });

  it("rejects receipt substitution and cannot publish after a blocker", () => {
    const planned = initializePublication(null, plan);
    expect(() =>
      recordPublication(planned, { ...receipt, head: "9".repeat(40) }),
    ).toThrow("does not match its admitted plan");
    expect(() =>
      recordPublication(blockPublication(planned, "human-input"), receipt),
    ).toThrow("Blocked publication");
  });
});
