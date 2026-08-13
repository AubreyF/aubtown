import { describe, expect, it } from "vitest";
import {
  BOUNDED_CONCURRENCY_POLICY,
  PILOT_CONCURRENCY_POLICY,
  decideConflict,
} from "../src/policy/conflicts.js";
import { claim, report } from "./helpers.js";

describe("conflict control", () => {
  it("keeps the pilot at one worker", () => {
    const result = decideConflict({
      candidate: report({ ownedPaths: ["docs/guide.md"], logicalLocks: ["docs"] }),
      activeClaims: [claim()],
      activeLanes: ["runtime-neutral"],
      policy: PILOT_CONCURRENCY_POLICY,
    });
    expect(result.reason).toBe("global-cap");
  });

  it("permits two disjoint runtime-neutral tasks after the pilot", () => {
    const result = decideConflict({
      candidate: report({ ownedPaths: ["docs/guide.md"], logicalLocks: ["docs"] }),
      activeClaims: [claim()],
      activeLanes: ["runtime-neutral"],
      policy: BOUNDED_CONCURRENCY_POLICY,
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects overlapping logical domains", () => {
    const result = decideConflict({
      candidate: report(),
      activeClaims: [claim()],
      activeLanes: ["runtime-neutral"],
      policy: BOUNDED_CONCURRENCY_POLICY,
    });
    expect(result).toMatchObject({
      allowed: false,
      reason: "conflict-domain",
      conflicts: ["logical:tooling-validation", "path:scripts/lib"],
    });
  });

  it("keeps provider-visible work at unattended concurrency zero", () => {
    const result = decideConflict({
      candidate: report({ lane: "provider-visible", providerNames: ["x"] }),
      activeClaims: [],
      activeLanes: [],
      policy: BOUNDED_CONCURRENCY_POLICY,
    });
    expect(result.reason).toBe("unattended-lane-forbidden");
  });
});
