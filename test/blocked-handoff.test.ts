import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FreedClaimReleaseRequest } from "../src/adapters/freed/claim-broker.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import type { TrustedAdjudicationResult } from "../src/adjudication/trusted-runner.js";
import {
  BlockedHandoffCoordinator,
  BlockedHandoffTransactionStore,
  planBlockedHandoff,
} from "../src/orchestration/blocked-handoff.js";
import { claim, FREED_REPOSITORY } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

async function store(): Promise<BlockedHandoffTransactionStore> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-blocked-handoff-")),
  );
  roots.push(root);
  return new BlockedHandoffTransactionStore(root);
}

const activeClaim = claim();
const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: activeClaim.issueNumber,
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

const blocked: TrustedAdjudicationResult = {
  schemaVersion: 1,
  kind: "trusted-adjudication",
  commandId: workProduct.commandId,
  outcome: "blocked",
  validation: {
    schemaVersion: 1,
    kind: "exact-validation",
    workProduct,
    passed: false,
    commands: [
      {
        argv: ["npm", "test"],
        cwd: workProduct.worktree,
        exitCode: 1,
        outputDigest: "1".repeat(64),
        durationMs: 10,
      },
    ],
    completedAt: "2026-08-14T12:00:30.000Z",
    summary: "Validation failed.",
  },
  completedAt: "2026-08-14T12:00:30.000Z",
};

const plan = planBlockedHandoff({
  adjudication: blocked,
  claim: activeClaim,
  repository: "freed-project/freed",
  taskId: "task-1234",
  taskRevision: 7,
  bindingDigest: "f".repeat(64),
  heartbeatAt: "2026-08-14T12:00:20.000Z",
  now: "2026-08-14T12:01:00.000Z",
});

describe("blocked handoff", () => {
  it("records whether validation or independent review blocked handoff", () => {
    expect(plan.adjudication.blockedStage).toBe("validation");
    expect(plan.releaseCommand.operationId[14]).toBe("4");
    const reviewBlocked = planBlockedHandoff({
      adjudication: {
        ...blocked,
        validation: {
          ...blocked.validation,
          passed: true,
          commands: blocked.validation.commands.map((command) => ({
            ...command,
            exitCode: 0,
          })),
        },
        review: {
          schemaVersion: 1,
          kind: "independent-review",
          workProduct,
          reviewer: {
            driverId: "codex-app-server-review-v1",
            threadId: "review-thread",
            turnId: "review-turn",
          },
          verdict: "changes-requested",
          findings: [],
          completedAt: "2026-08-14T12:00:30.000Z",
          summary: "Changes requested.",
        },
      },
      claim: activeClaim,
      repository: "freed-project/freed",
      taskId: "task-1234",
      taskRevision: 7,
      bindingDigest: "f".repeat(64),
      heartbeatAt: "2026-08-14T12:00:20.000Z",
      now: "2026-08-14T12:01:00.000Z",
    });
    expect(reviewBlocked.adjudication.blockedStage).toBe(
      "independent-review",
    );
    expect(reviewBlocked.projection.commentBody).toContain(
      "Stage: independent-review",
    );
  });

  it("projects blocked state and replays exact cleanup after a lost response", async () => {
    const transactions = await store();
    let projectionCalls = 0;
    const releaseCommands: FreedClaimReleaseRequest[] = [];
    const coordinator = new BlockedHandoffCoordinator(
      transactions,
      {
        write: async (input) => {
          projectionCalls += 1;
          expect(input.projection.commentBody).toContain(
            "Factory state: blocked",
          );
          expect(input.projection.commentBody).toContain(
            "Blocker: Exact validation failed.",
          );
          return {
            repository: "freed-project/freed",
            issueNumber: activeClaim.issueNumber,
            labelsChanged: true,
            commentAction: "update",
            tokenExpiresAt: "2026-08-14T13:00:00.000Z",
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

    await expect(
      coordinator.run({ plan, projectionApproved: true }),
    ).rejects.toThrow("response lost");
    await expect(
      coordinator.run({ plan, projectionApproved: false }),
    ).resolves.toMatchObject({ stage: "released" });
    expect(projectionCalls).toBe(1);
    expect(releaseCommands).toHaveLength(2);
    expect(releaseCommands[1]).toEqual(releaseCommands[0]);
  });

  it("replays a broker-compatible UUID for a durable legacy plan", async () => {
    const transactions = await store();
    const legacyPlan = {
      ...plan,
      releaseCommand: {
        ...plan.releaseCommand,
        operationId: `${plan.releaseCommand.operationId.slice(0, 14)}8${plan.releaseCommand.operationId.slice(15)}`,
      },
    };
    let released: FreedClaimReleaseRequest | undefined;
    const coordinator = new BlockedHandoffCoordinator(
      transactions,
      {
        write: async () => ({
          repository: "freed-project/freed",
          issueNumber: activeClaim.issueNumber,
          labelsChanged: false,
          commentAction: "update",
          tokenExpiresAt: "2026-08-14T13:00:00.000Z",
        }),
      },
      {
        release: async (command) => {
          released = command;
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

    await expect(
      coordinator.run({ plan: legacyPlan, projectionApproved: true }),
    ).resolves.toMatchObject({ stage: "released" });
    expect(legacyPlan.releaseCommand.operationId[14]).toBe("8");
    expect(released?.operationId[14]).toBe("4");
  });

  it("cannot project while the pilot write gate is disabled", async () => {
    let projected = false;
    const coordinator = new BlockedHandoffCoordinator(
      await store(),
      {
        write: async () => {
          projected = true;
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
    expect(projected).toBe(false);
  });
});
