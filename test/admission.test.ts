import { describe, expect, it } from "vitest";
import { qualifyIssue } from "../src/policy/admission.js";
import { FREED_REPOSITORY, evidence, issue, report } from "./helpers.js";

describe("qualifyIssue", () => {
  it("qualifies one bounded runtime-neutral issue with exact authority", () => {
    const result = report();
    expect(result.eligible).toBe(true);
    expect(result.workLane).toBe("runtime-neutral");
    expect(result.conflictDomains).toEqual([
      "logical:tooling-validation",
      "path:scripts/lib",
    ]);
  });

  it("never treats debt alone as execution authority", () => {
    const result = qualifyIssue({
      repository: FREED_REPOSITORY,
      issue: issue({ labels: ["debt"] }),
      evidence: evidence(),
    });
    expect(result.eligible).toBe(false);
    expect(
      result.checks.filter((check) => !check.passed).map((check) => check.id),
    ).toEqual(["factory-ready", "active-authority"]);
  });

  it("excludes automation incidents and provider-visible work", () => {
    const result = qualifyIssue({
      repository: FREED_REPOSITORY,
      issue: issue({ labels: ["debt", "factory:ready", "automation-triage"] }),
      evidence: evidence({ providerNames: ["facebook"] }),
      requireExecutionAuthority: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.workLane).toBe("provider-visible");
    expect(result.conflictDomains).toContain("provider:global");
  });

  it("fails incomplete and duplicate issues closed", () => {
    const result = qualifyIssue({
      repository: FREED_REPOSITORY,
      issue: issue(),
      evidence: { duplicateOf: 999 },
      requireExecutionAuthority: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.priorityScore).toBe(0);
  });
});
