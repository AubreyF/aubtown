import { describe, expect, it } from "vitest";
import {
  applyReview,
  applyValidation,
  initializeHandoff,
} from "../src/orchestration/handoff-registry.js";
import type {
  ExactValidationReceipt,
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import { FREED_REPOSITORY } from "./helpers.js";

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
  head: "c".repeat(40),
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

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
      outputDigest: "f".repeat(64),
      durationMs: 1_000,
    },
  ],
  completedAt: "2026-08-13T18:00:30.000Z",
  summary: "Validation passed.",
};

const review: IndependentReviewReceipt = {
  schemaVersion: 1,
  kind: "independent-review",
  workProduct,
  reviewer: {
    driverId: "codex-app-server-review-v1",
    threadId: "review-thread",
    turnId: "review-turn",
  },
  verdict: "pass",
  findings: [],
  completedAt: "2026-08-13T18:00:45.000Z",
  summary: "Review passed.",
};

describe("durable handoff reducer", () => {
  it("advances only validation then fresh review to ready", () => {
    const initialized = initializeHandoff(null, workProduct);
    expect(initialized.stage).toBe("awaiting-validation");
    const validated = applyValidation(initialized, validation);
    expect(validated.stage).toBe("awaiting-review");
    expect(applyReview(validated, review)).toMatchObject({
      stage: "ready",
      reasons: [],
    });
  });

  it("blocks failed validation before review", () => {
    const blocked = applyValidation(initializeHandoff(null, workProduct), {
      ...validation,
      passed: false,
      commands: [{ ...validation.commands[0]!, exitCode: 1 }],
    });
    expect(blocked).toMatchObject({
      stage: "blocked",
      reasons: ["validation-failed"],
    });
    expect(() => applyReview(blocked, review)).toThrow("not awaiting");
  });

  it("is idempotent only for byte-equivalent receipts", () => {
    const validated = applyValidation(
      initializeHandoff(null, workProduct),
      validation,
    );
    expect(applyValidation(validated, validation)).toEqual(validated);
    expect(() =>
      applyValidation(validated, {
        ...validation,
        summary: "Another validation result.",
      }),
    ).toThrow("another validation receipt");
  });
});
