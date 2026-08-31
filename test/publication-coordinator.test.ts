import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FreedClaimReleaseRequest } from "../src/adapters/freed/claim-broker.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import {
  bindPublishedDraftProjection,
  DurablePublicationCoordinator,
} from "../src/orchestration/publication-coordinator.js";
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

async function transactionStore(): Promise<PublicationTransactionStore> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-publication-coordinator-")),
  );
  roots.push(root);
  return new PublicationTransactionStore(root);
}

function fixture(): {
  readonly plan: PublicationPlan;
  readonly publication: DraftPublicationReceipt;
} {
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
  return {
    plan,
    publication: {
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
    },
  };
}

describe("durable publication coordinator", () => {
  it("replays one deterministic cleanup command after an ambiguous response", async () => {
    const { plan, publication } = fixture();
    const transactions = await transactionStore();
    let publicationCalls = 0;
    let projectionCalls = 0;
    const releaseCommands: FreedClaimReleaseRequest[] = [];
    const coordinator = new DurablePublicationCoordinator(
      transactions,
      {
        publish: async () => {
          publicationCalls += 1;
          return publication;
        },
      },
      {
        write: async (input) => {
          projectionCalls += 1;
          expect(input.projection.commentBody).toContain(
            "Draft pull request: #42",
          );
          return {
            repository: "freed-project/freed",
            issueNumber: 1_234,
            labelsChanged: true,
            commentAction: "create",
            tokenExpiresAt: "2026-08-14T13:02:00.000Z",
          };
        },
      },
      {
        release: async (command) => {
          releaseCommands.push(command);
          if (releaseCommands.length === 1) {
            throw new Error("release response lost after commit");
          }
          return {
            schemaVersion: 1,
            operationId: command.operationId,
            taskId: command.taskId,
            taskRevision: command.expectedTaskRevision,
            authorityClaimId: command.authorityClaimId,
            bindingDigest: command.bindingDigest,
            custodyEpoch: command.custodyEpoch,
            expectedHeartbeatAt: command.expectedHeartbeatAt,
            reason: command.reason,
            releasedAt: command.releasedAt,
          };
        },
      },
    );
    const release = {
      taskId: "task-1234",
      taskRevision: 7,
      authorityClaimId: plan.workProduct!.claimId,
      bindingDigest: "f".repeat(64),
      custodyEpoch: plan.workProduct!.custodyEpoch,
      expectedHeartbeatAt: "2026-08-14T12:01:30.000Z",
      releasedAt: "2026-08-14T12:02:00.000Z",
    };

    await expect(
      coordinator.run({ plan, projectionApproved: true, release }),
    ).rejects.toThrow("response lost");
    await expect(
      coordinator.run({ plan, projectionApproved: true }),
    ).resolves.toMatchObject({ stage: "released" });
    expect(publicationCalls).toBe(1);
    expect(projectionCalls).toBe(1);
    expect(releaseCommands).toHaveLength(2);
    expect(releaseCommands[1]).toEqual(releaseCommands[0]);
    expect(releaseCommands[0]?.operationId[14]).toBe("4");
  });

  it("rejects a projection bound to another draft", () => {
    const { plan } = fixture();
    const projection = bindPublishedDraftProjection(plan, 42);
    expect(projection.commentBody).toContain("Draft pull request: #42");
    expect(() =>
      bindPublishedDraftProjection(
        {
          ...plan,
          projection: {
            ...plan.projection!,
            commentBody: plan.projection!.commentBody.replace(
              "pending creation",
              "#41",
            ),
          },
        },
        42,
      ),
    ).toThrow("names another draft");
  });

  it("does not publish while the lifecycle projection gate is disabled", async () => {
    const { plan } = fixture();
    let called = false;
    const coordinator = new DurablePublicationCoordinator(
      await transactionStore(),
      {
        publish: async () => {
          called = true;
          throw new Error("must not publish");
        },
      },
      {
        write: async () => {
          throw new Error("must not project");
        },
      },
      {
        release: async () => {
          throw new Error("must not release");
        },
      },
    );
    await expect(
      coordinator.run({ plan, projectionApproved: false }),
    ).rejects.toThrow("requires the lifecycle projection pilot gate");
    expect(called).toBe(false);
  });
});
