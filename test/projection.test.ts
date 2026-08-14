import { describe, expect, it } from "vitest";
import {
  buildStatusProjection,
  findManagedStatusComment,
  STATUS_COMMENT_MARKER,
} from "../src/projection/status.js";
import { claim } from "./helpers.js";

describe("status projection", () => {
  it("uses one recognizable AI-prefixed machine status body", () => {
    const projection = buildStatusProjection({
      state: "blocked",
      stage: "blocked",
      summary: "Waiting for supported authority recovery.",
      claim: claim({ claimId: "claim-1117" }),
      accountId: "subscription-1",
      lastHeartbeatAt: "2026-08-13T17:59:45.000Z",
      draftPullRequest: "none planned",
      blocker: "Supported authority recovery is required.",
      nextAction: "Owner repairs the canonical authority channel.",
      updatedAt: "2026-08-13T18:00:00.000Z",
    });
    expect(projection.commentBody.startsWith("(AI Generated).\n\n")).toBe(true);
    expect(projection.commentBody).toContain(STATUS_COMMENT_MARKER);
    expect(projection.labelsToAdd).toEqual(["factory:blocked"]);
    expect(projection.labelsToRemove).not.toContain("factory:blocked");
    expect(projection.commentBody).toContain("Assigned host: linux-control-1");
    expect(projection.commentBody).toContain("Assigned worker: worker-1");
    expect(projection.commentBody).toContain("Custody epoch: 1");
    expect(projection.commentBody).toContain("Branch: fix/deterministic-validation");
  });

  it("represents an unclaimed ready issue without mutating its description", () => {
    const projection = buildStatusProjection({
      state: "ready",
      stage: "awaiting-dispatch",
      summary: "Qualified and waiting for an admitted route.",
      nextAction: "Coordinator checks quota, conflicts, and repository authority.",
      updatedAt: "2026-08-13T18:00:00.000Z",
    });
    expect(projection.commentBody).toContain("Assigned host: none");
    expect(projection.commentBody).toContain("Claim: none");
    expect(projection.commentBody).toContain("Draft pull request: none");
  });

  it("rejects lifecycle states whose visible details contradict authority", () => {
    expect(() =>
      buildStatusProjection({
        state: "running",
        stage: "implementation",
        summary: "Missing a claim.",
        updatedAt: "2026-08-13T18:00:00.000Z",
      }),
    ).toThrow(/requires a durable claim/);
    expect(() =>
      buildStatusProjection({
        state: "blocked",
        stage: "blocked",
        summary: "Missing a blocker.",
        updatedAt: "2026-08-13T18:00:00.000Z",
      }),
    ).toThrow(/requires a blocker/);
  });

  it("finds the existing managed comment instead of planning comment spam", () => {
    const comments = [
      { body: "A human comment." },
      { body: `(AI Generated).\n\n${STATUS_COMMENT_MARKER}\nFactory state: ready` },
    ];
    expect(findManagedStatusComment(comments)).toBe(comments[1]);
  });
});
