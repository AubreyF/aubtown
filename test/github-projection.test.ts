import { describe, expect, it } from "vitest";
import { planProjectionMutation } from "../src/projection/github-writer.js";
import { buildStatusProjection, STATUS_COMMENT_MARKER } from "../src/projection/status.js";
import { claim } from "./helpers.js";

const projection = buildStatusProjection({
  state: "running",
  stage: "implementation",
  summary: "Worker owns the current claim.",
  claim: claim(),
  lastHeartbeatAt: "2026-08-13T17:59:45.000Z",
  nextAction: "Wait for the implementation turn.",
  updatedAt: "2026-08-13T18:00:00.000Z",
});

describe("GitHub lifecycle projection", () => {
  it("preserves human labels and replaces only machine lifecycle labels", () => {
    const plan = planProjectionMutation({
      currentLabels: ["debt", "priority:high", "factory:ready"],
      comments: [],
      machineAuthorLogin: "aubtown-coordinator[bot]",
      projection,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.labels).toEqual(["debt", "factory:running", "priority:high"]);
    expect(plan.comment.action).toBe("create");
  });

  it("updates the one App-authored managed comment", () => {
    const plan = planProjectionMutation({
      currentLabels: ["debt", "factory:running"],
      comments: [
        {
          id: 10,
          authorLogin: "aubtown-coordinator[bot]",
          body: `(AI Generated).\n\n${STATUS_COMMENT_MARKER}\nOld state`,
        },
        {
          id: 11,
          authorLogin: "human",
          body: `${STATUS_COMMENT_MARKER}\nSpoofed marker`,
        },
      ],
      machineAuthorLogin: "aubtown-coordinator[bot]",
      projection,
    });
    expect(plan.comment).toMatchObject({ action: "update", id: 10 });
  });

  it("fails closed instead of choosing among duplicate managed comments", () => {
    const comments = [1, 2].map((id) => ({
      id,
      authorLogin: "aubtown-coordinator[bot]",
      body: `(AI Generated).\n\n${STATUS_COMMENT_MARKER}`,
    }));
    const plan = planProjectionMutation({
      currentLabels: ["debt"],
      comments,
      machineAuthorLogin: "aubtown-coordinator[bot]",
      projection,
    });
    expect(plan).toMatchObject({ allowed: false, reason: "duplicate-managed-comments" });
  });
});
