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

const head = "c".repeat(40);

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
    validation: {
      head,
      passed: true,
      completedAt: "2026-08-13T08:00:30.000Z",
      summary: "Focused validation passed.",
    },
    review: {
      head,
      passed: true,
      completedAt: "2026-08-13T08:00:45.000Z",
      summary: "Independent review passed.",
    },
    title: "fix: make validation deterministic",
    bodySummary: "Makes the qualified validation ordering deterministic.",
    now: "2026-08-13T08:01:00.000Z",
    ...overrides,
  });
}

describe("draft publication policy", () => {
  it("plans only a draft with AI-prefixed external bodies", () => {
    const result = plan();
    expect(result).toMatchObject({ allowed: true, action: "create-draft" });
    expect(result.body?.startsWith("(AI Generated).\n\n")).toBe(true);
    expect(result.projection?.commentBody.startsWith("(AI Generated).\n\n")).toBe(true);
  });

  it("blocks stale custody and non-exact validation", () => {
    const result = plan({
      currentClaim: claim({ custodyEpoch: 2 }),
      validation: {
        head: "d".repeat(40),
        passed: true,
        completedAt: "2026-08-13T08:00:30.000Z",
        summary: "Wrong head.",
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["current-custody-not-proven", "validation-not-exact-head"]),
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
});
