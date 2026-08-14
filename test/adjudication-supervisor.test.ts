import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAdjudicationCommand } from "../src/adjudication/command.js";
import {
  HostAdjudicationJournal,
  type HostReviewHandle,
} from "../src/adjudication/journal.js";
import { HostAdjudicationSupervisor } from "../src/adjudication/supervisor.js";
import type {
  ExactValidationReceipt,
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import { FREED_REPOSITORY, report } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  branch: "fix/deterministic-validation",
  worktree: "/worktrees/1234",
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead: "a".repeat(40),
  head: "b".repeat(40),
  patchDigest: "c".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

const command = createAdjudicationCommand({
  commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
  workProduct,
  qualification: report(),
  accountId: "codex-pro-1",
  reviewerDriverId: "codex-app-server-review-v1",
  validationCommands: [
    { executable: "/opt/node/bin/npm", args: ["test"], timeoutMs: 60_000 },
  ],
  issuedAt: "2026-08-13T18:00:00.000Z",
});

const validation: ExactValidationReceipt = {
  schemaVersion: 1,
  kind: "exact-validation",
  workProduct,
  passed: true,
  commands: [
    {
      argv: ["/opt/node/bin/npm", "test"],
      cwd: workProduct.worktree,
      exitCode: 0,
      outputDigest: "e".repeat(64),
      durationMs: 1_000,
    },
  ],
  completedAt: "2026-08-13T18:00:01.000Z",
  summary: "Validation passed.",
};

const reviewHandle: HostReviewHandle = {
  driverId: "codex-app-server-review-v1",
  threadId: "review-thread",
  turnId: "review-turn",
  startedAt: "2026-08-13T18:00:02.000Z",
  workProduct,
};

const review: IndependentReviewReceipt = {
  schemaVersion: 1,
  kind: "independent-review",
  workProduct,
  reviewer: {
    driverId: reviewHandle.driverId,
    threadId: reviewHandle.threadId,
    turnId: reviewHandle.turnId,
  },
  verdict: "pass",
  findings: [],
  completedAt: "2026-08-13T18:00:03.000Z",
  summary: "Review passed.",
};

async function waitFor(
  journal: HostAdjudicationJournal,
  stage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await journal.read())?.stage === stage) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for adjudication stage ${stage}.`);
}

describe("HostAdjudicationSupervisor", () => {
  it("runs exact validation then a fresh review without blocking the poll loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-adjudication-"));
    roots.push(root);
    const journal = new HostAdjudicationJournal(join(root, "journal.json"));
    let polls = 0;
    const reported: string[] = [];
    const supervisor = new HostAdjudicationSupervisor(
      "codex-pro-1",
      { run: async () => validation },
      {
        id: "codex-app-server-review-v1",
        start: async () => reviewHandle,
        wait: async () => review,
      },
      journal,
      {
        pollAdjudication: async () => {
          polls += 1;
          return {
            kind: "adjudication-poll",
            hostId: workProduct.hostId,
            sequence: polls,
            acceptedAt: `2026-08-13T18:00:0${polls}.000Z`,
            command,
            action: polls === 1 ? "validate" : "review",
            reason: "offered",
          };
        },
        reportValidation: async () => {
          reported.push("validation");
          return {
            kind: "validation-receipt",
            hostId: workProduct.hostId,
            sequence: 3,
            acceptedAt: "2026-08-13T18:00:03.000Z",
            checkpointReference: workProduct.checkpointReference,
            stage: "awaiting-review",
          };
        },
        reportReview: async () => {
          reported.push("review");
          return {
            kind: "review-receipt",
            hostId: workProduct.hostId,
            sequence: 4,
            acceptedAt: "2026-08-13T18:00:04.000Z",
            checkpointReference: workProduct.checkpointReference,
            stage: "ready",
          };
        },
      },
      { PATH: "/opt/node/bin:/usr/bin:/bin" },
      () => {},
      () => new Date("2026-08-13T18:00:00.000Z"),
    );

    await expect(supervisor.reconcile()).resolves.toBe("validation-running");
    await waitFor(journal, "validation-reported");
    await expect(supervisor.reconcile()).resolves.toBe("review-starting");
    await waitFor(journal, "complete");
    expect(reported).toEqual(["validation", "review"]);
    await expect(journal.read()).resolves.toMatchObject({
      stage: "complete",
      validation,
      review,
      reviewHandle,
    });
  });

  it("fails closed when validation start outcome is ambiguous after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-adjudication-"));
    roots.push(root);
    const journal = new HostAdjudicationJournal(join(root, "journal.json"));
    await journal.accept(command, "validate", "2026-08-13T18:00:00.000Z");
    await journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "validation-starting",
    }));
    const supervisor = new HostAdjudicationSupervisor(
      "codex-pro-1",
      { run: async () => validation },
      { id: "codex-app-server-review-v1", start: async () => reviewHandle, wait: async () => review },
      journal,
      {
        pollAdjudication: async () => { throw new Error("must not poll"); },
        reportValidation: async () => { throw new Error("must not report"); },
        reportReview: async () => { throw new Error("must not report"); },
      },
      {},
      () => {},
    );

    await expect(supervisor.reconcile()).rejects.toThrow("ambiguous");
  });

  it("resumes one journaled reviewer handle instead of starting another", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-adjudication-"));
    roots.push(root);
    const journal = new HostAdjudicationJournal(join(root, "journal.json"));
    await journal.accept(command, "review", "2026-08-13T18:00:00.000Z");
    await journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "review-started",
      reviewHandle,
    }));
    let starts = 0;
    const supervisor = new HostAdjudicationSupervisor(
      "codex-pro-1",
      { run: async () => validation },
      {
        id: "codex-app-server-review-v1",
        start: async () => { starts += 1; return reviewHandle; },
        wait: async () => review,
      },
      journal,
      {
        pollAdjudication: async () => { throw new Error("must not poll"); },
        reportValidation: async () => { throw new Error("must not report"); },
        reportReview: async () => ({
          kind: "review-receipt",
          hostId: workProduct.hostId,
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:04.000Z",
          checkpointReference: workProduct.checkpointReference,
          stage: "ready",
        }),
      },
      {},
      () => {},
    );

    await expect(supervisor.reconcile()).resolves.toBe("review-running");
    await waitFor(journal, "complete");
    expect(starts).toBe(0);
  });

  it("retries only a persisted validation receipt after a report outage", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-adjudication-"));
    roots.push(root);
    const journal = new HostAdjudicationJournal(join(root, "journal.json"));
    let validationRuns = 0;
    let reportAttempts = 0;
    let polls = 0;
    const supervisor = new HostAdjudicationSupervisor(
      "codex-pro-1",
      {
        run: async () => {
          validationRuns += 1;
          return validation;
        },
      },
      {
        id: "codex-app-server-review-v1",
        start: async () => reviewHandle,
        wait: async () => review,
      },
      journal,
      {
        pollAdjudication: async () => {
          polls += 1;
          return polls === 1
            ? {
                kind: "adjudication-poll",
                hostId: workProduct.hostId,
                sequence: polls,
                acceptedAt: "2026-08-13T18:00:01.000Z",
                command,
                action: "validate",
                reason: "offered",
              }
            : {
                kind: "adjudication-poll",
                hostId: workProduct.hostId,
                sequence: polls,
                acceptedAt: "2026-08-13T18:00:03.000Z",
                command: null,
                action: null,
                reason: "no-command",
              };
        },
        reportValidation: async () => {
          reportAttempts += 1;
          if (reportAttempts === 1) {
            throw new Error("coordinator unavailable");
          }
          return {
            kind: "validation-receipt",
            hostId: workProduct.hostId,
            sequence: 3,
            acceptedAt: "2026-08-13T18:00:03.000Z",
            checkpointReference: workProduct.checkpointReference,
            stage: "awaiting-review",
          };
        },
        reportReview: async () => {
          throw new Error("must not review");
        },
      },
      {},
      () => {},
    );

    await supervisor.reconcile();
    await waitFor(journal, "validated");
    await expect(supervisor.reconcile()).resolves.toBe("no-command");
    expect(validationRuns).toBe(1);
    expect(reportAttempts).toBe(2);
    await expect(journal.read()).resolves.toMatchObject({
      stage: "validation-reported",
      validation,
    });
  });
});
