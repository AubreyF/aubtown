import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FreedClaimReleaseReceipt,
  FreedClaimReleaseRequest,
} from "../src/adapters/freed/claim-broker.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import { PublicationTransactionStore } from "../src/orchestration/publication-transaction.js";
import type { DraftPublicationReceipt } from "../src/publication/draft-publisher.js";
import type { PublicationPlan } from "../src/publication/policy.js";
import { buildStatusProjection } from "../src/projection/status.js";
import { claim, FREED_REPOSITORY } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

const activeClaim = claim();
const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: activeClaim.claimId,
  custodyEpoch: activeClaim.custodyEpoch,
  hostId: activeClaim.hostId,
  branch: activeClaim.branch,
  worktree: activeClaim.worktree,
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
  projection: buildStatusProjection({
    state: "human-review",
    stage: "handoff",
    summary: `Draft pull request prepared at exact head ${workProduct.head}.`,
    claim: activeClaim,
    draftPullRequest: "pending creation",
    nextAction: "Owner reviews the draft pull request.",
    updatedAt: "2026-08-14T12:00:00.000Z",
  }),
};

const publication: DraftPublicationReceipt = {
  schemaVersion: 1,
  repository: "freed-project/freed",
  checkpointReference: workProduct.checkpointReference,
  branch: workProduct.branch,
  head: workProduct.head,
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/freed-project/freed/pull/42",
  draft: true,
  publishedAt: "2026-08-14T12:01:00.000Z",
  tokenExpiresAt: "2026-08-14T13:00:00.000Z",
};

const releaseCommand: FreedClaimReleaseRequest = {
  schemaVersion: 1,
  operationId: "adb5c0a7-d9a0-4daa-9fc8-fc53122683ca",
  taskId: "task-1234",
  expectedTaskRevision: 7,
  authorityClaimId: workProduct.claimId,
  bindingDigest: "f".repeat(64),
  custodyEpoch: workProduct.custodyEpoch,
  expectedHeartbeatAt: "2026-08-14T12:01:30.000Z",
  reason: "worker-completed",
  releasedAt: "2026-08-14T12:02:00.000Z",
};

const release: FreedClaimReleaseReceipt = {
  schemaVersion: 1,
  operationId: releaseCommand.operationId,
  taskId: releaseCommand.taskId,
  taskRevision: releaseCommand.expectedTaskRevision,
  authorityClaimId: releaseCommand.authorityClaimId,
  bindingDigest: releaseCommand.bindingDigest,
  custodyEpoch: releaseCommand.custodyEpoch,
  expectedHeartbeatAt: releaseCommand.expectedHeartbeatAt,
  reason: releaseCommand.reason,
  releasedAt: releaseCommand.releasedAt,
};

async function store(): Promise<PublicationTransactionStore> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-publication-")),
  );
  roots.push(root);
  return new PublicationTransactionStore(root);
}

describe("publication transaction store", () => {
  it("resumes every external boundary from immutable stage receipts", async () => {
    const transactions = await store();
    await expect(transactions.recordPlan(plan)).resolves.toMatchObject({
      stage: "planned",
    });
    await expect(
      transactions.recordPublication(workProduct.checkpointReference, publication),
    ).resolves.toMatchObject({ stage: "published" });
    await expect(
      transactions.recordProjection(workProduct.checkpointReference, {
        repository: "freed-project/freed",
        issueNumber: workProduct.issueNumber,
        labelsChanged: true,
        commentAction: "create",
        tokenExpiresAt: "2026-08-14T13:02:00.000Z",
      }),
    ).resolves.toMatchObject({ stage: "projected" });
    await transactions.recordReleaseCommand(
      workProduct.checkpointReference,
      releaseCommand,
    );
    await expect(
      transactions.recordRelease(workProduct.checkpointReference, release),
    ).resolves.toMatchObject({ stage: "released" });

    await expect(
      transactions.load(workProduct.checkpointReference),
    ).resolves.toMatchObject({
      stage: "released",
      publication,
      releaseCommand,
      release,
    });
  });

  it("rejects stage substitution and cleanup before projection", async () => {
    const transactions = await store();
    await transactions.recordPlan(plan);
    await expect(
      transactions.recordPlan({ ...plan, title: "fix: substitute title" }),
    ).rejects.toThrow("conflicts with immutable content");
    await transactions.recordPublication(
      workProduct.checkpointReference,
      publication,
    );
    await expect(
      transactions.recordReleaseCommand(
        workProduct.checkpointReference,
        releaseCommand,
      ),
    ).rejects.toThrow("requires lifecycle projection first");
    await expect(
      transactions.recordProjection(workProduct.checkpointReference, {
        repository: "another/repository",
        issueNumber: workProduct.issueNumber,
        labelsChanged: false,
        commentAction: "none",
        tokenExpiresAt: "2026-08-14T13:02:00.000Z",
      }),
    ).rejects.toThrow("names another publication");
  });
});
