import { describe, expect, it } from "vitest";
import {
  assessHandoff,
  independentReviewReceiptSchema,
  type ExactValidationReceipt,
  type IndependentReviewReceipt,
  type WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import { FREED_REPOSITORY } from "./helpers.js";

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  head: "c".repeat(40),
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

function validation(
  overrides: Partial<ExactValidationReceipt> = {},
): ExactValidationReceipt {
  return {
    schemaVersion: 1,
    kind: "exact-validation",
    workProduct,
    passed: true,
    commands: [
      {
        argv: ["npm", "test"],
        cwd: "/worktrees/1234",
        exitCode: 0,
        outputDigest: "f".repeat(64),
        durationMs: 1_000,
      },
    ],
    completedAt: "2026-08-13T18:00:30.000Z",
    summary: "Focused validation passed.",
    ...overrides,
  };
}

function review(
  overrides: Partial<IndependentReviewReceipt> = {},
): IndependentReviewReceipt {
  return {
    schemaVersion: 1,
    kind: "independent-review",
    workProduct,
    reviewer: {
      driverId: "codex-app-server-v1",
      threadId: "review-thread",
      turnId: "review-turn",
    },
    verdict: "pass",
    findings: [],
    completedAt: "2026-08-13T18:00:45.000Z",
    summary: "Independent review passed.",
    ...overrides,
  };
}

describe("post-worker adjudication receipts", () => {
  it("admits only validation and review of the same work product", () => {
    expect(
      assessHandoff({ workProduct, validation: validation(), review: review() }),
    ).toEqual({ ready: true, reasons: [] });
  });

  it("rejects a fresh-head substitution after validation", () => {
    const changed = { ...workProduct, head: "a".repeat(40) };
    expect(
      assessHandoff({
        workProduct: changed,
        validation: validation(),
        review: review({ workProduct: changed }),
      }),
    ).toEqual({
      ready: false,
      reasons: ["validation-work-product-mismatch"],
    });
  });

  it("fails closed on a nonzero validation command", () => {
    const failedCommand = {
      ...validation(),
      commands: [{ ...validation().commands[0]!, exitCode: 1 }],
    };
    expect(
      assessHandoff({
        workProduct,
        validation: failedCommand,
        review: review(),
      }).reasons,
    ).toContain("validation-failed");
  });

  it("requires a fresh reviewer thread", () => {
    expect(() =>
      independentReviewReceiptSchema.parse(
        review({
          reviewer: {
            driverId: "codex-app-server-v1",
            threadId: workProduct.implementation.threadId,
            turnId: "another-turn",
          },
        }),
      ),
    ).toThrow("fresh thread");
  });

  it("does not allow a pass verdict with serious findings", () => {
    expect(() =>
      independentReviewReceiptSchema.parse(
        review({
          findings: [
            {
              severity: "high",
              title: "Authority bypass",
              body: "The new path bypasses the claim check.",
            },
          ],
        }),
      ),
    ).toThrow("cannot contain blocker or high findings");
  });
});
