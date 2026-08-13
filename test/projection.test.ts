import { describe, expect, it } from "vitest";
import {
  buildStatusProjection,
  findManagedStatusComment,
  STATUS_COMMENT_MARKER,
} from "../src/projection/status.js";

describe("status projection", () => {
  it("uses one recognizable AI-prefixed machine status body", () => {
    const projection = buildStatusProjection({
      state: "blocked",
      summary: "Waiting for supported authority recovery.",
      claimId: "claim-1117",
      updatedAt: "2026-08-13T18:00:00.000Z",
    });
    expect(projection.commentBody.startsWith("(AI Generated).\n\n")).toBe(true);
    expect(projection.commentBody).toContain(STATUS_COMMENT_MARKER);
    expect(projection.labelsToAdd).toEqual(["factory:blocked"]);
    expect(projection.labelsToRemove).not.toContain("factory:blocked");
  });

  it("finds the existing managed comment instead of planning comment spam", () => {
    const comments = [
      { body: "A human comment." },
      { body: `(AI Generated).\n\n${STATUS_COMMENT_MARKER}\nFactory state: ready` },
    ];
    expect(findManagedStatusComment(comments)).toBe(comments[1]);
  });
});
