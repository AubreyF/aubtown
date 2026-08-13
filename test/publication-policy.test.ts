import { describe, expect, it } from "vitest";
import { planDraftPublication } from "../src/publication/policy.js";
import { decideQuota } from "../src/policy/quota.js";
import {
  authorityTask,
  claim,
  FREED_REPOSITORY,
  report,
  usage,
} from "./helpers.js";
import type {
  ExactValidationReceipt,
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";

const head = "c".repeat(40);
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
  head,
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
      argv: ["npm", "test"],
      cwd: "/worktrees/1234",
      exitCode: 0,
      outputDigest: "f".repeat(64),
      durationMs: 1_000,
    },
  ],
  completedAt: "2026-08-13T08:00:30.000Z",
  summary: "Focused validation passed.",
};

const review: IndependentReviewReceipt = {
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
  completedAt: "2026-08-13T08:00:45.000Z",
  summary: "Independent review passed.",
};

function plan(overrides: Partial<Parameters<typeof planDraftPublication>[0]> = {}) {
  const qualified = report();
  const activeClaim = claim();
  return planDraftPublication({
    repository: FREED_REPOSITORY,
    qualification: qualified,
    claim: activeClaim,
    currentClaim: activeClaim,
    authorityTask: authorityTask(),
    authorityActive: true,
    quota: decideQuota({ snapshot: usage(), now: "2026-08-13T08:01:00.000Z" }),
    publicationCeiling: "draft-pr",
    head,
    workProduct,
    validation,
    review,
    title: "fix: make validation deterministic",
    bodySummary: "Makes the qualified validation ordering deterministic.",
    now: "2026-08-13T08:01:00.000Z",
    ...overrides,
  });
}

describe("draft publication policy", () => {
  it("plans only a draft with AI-prefixed external bodies", () => {
    const result = plan();
    expect(result).toMatchObject({
      allowed: true,
      action: "create-draft",
      repository: "freed-project/freed",
      workProduct,
    });
    expect(result.body?.startsWith("(AI Generated).\n\n")).toBe(true);
    expect(result.projection?.commentBody.startsWith("(AI Generated).\n\n")).toBe(true);
  });

  it("blocks stale custody and non-exact validation", () => {
    const result = plan({
      currentClaim: claim({ custodyEpoch: 2 }),
      workProduct: { ...workProduct, head: "d".repeat(40) },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "current-custody-not-proven",
        "work-product-not-exact-head",
        "validation-work-product-mismatch",
        "review-work-product-mismatch",
      ]),
    );
  });

  it("rejects authorship giveaways in external titles", () => {
    expect(plan({ title: "fix: Codex validation ordering" }).reasons).toContain(
      "invalid-title",
    );
  });

  it("never updates a ready pull request", () => {
    const result = plan({
      existingPullRequest: {
        number: 42,
        branch: claim().branch,
        head,
        draft: false,
        state: "open",
      },
    });
    expect(result).toMatchObject({ allowed: false, action: "none" });
    expect(result.reasons).toContain("existing-pull-request-conflict");
  });

  it("binds a draft update to the observed pull request number and head", () => {
    expect(
      plan({
        existingPullRequest: {
          number: 42,
          branch: claim().branch,
          head: "b".repeat(40),
          draft: true,
          state: "open",
        },
      }),
    ).toMatchObject({
      allowed: true,
      action: "update-draft",
      pullRequestNumber: 42,
      expectedRemoteHead: "b".repeat(40),
    });
  });
});
