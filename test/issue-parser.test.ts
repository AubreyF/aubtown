import { describe, expect, it } from "vitest";
import { parseDebtIssueBody } from "../src/adapters/github/issue-parser.js";

describe("debt issue parser", () => {
  it("extracts canonical issue-form sections without inventing missing fields", () => {
    const parsed = parseDebtIssueBody(`### Root cause
Unsorted paths cause nondeterministic output.

### Evidence
The fixture alternates between two orders.

### Why this is deferred
It does not block active delivery.

### Done when
- Output is stable.
- The focused test passes.

### Scope and gates
Runtime-neutral tooling only.

### Validation
- npm run test:tooling

### Owned paths
- scripts/lib/validation-order.mjs

### Logical locks
- tooling-validation

### Host lane
linux

### Work lane
runtime-neutral

### Requires owner review
false

### Behavioral
false

### Release or migration risk
false
`);
    expect(parsed).toEqual({
      rootCause: "Unsorted paths cause nondeterministic output.",
      evidence: "The fixture alternates between two orders.",
      scope: "Runtime-neutral tooling only.",
      acceptanceCriteria: ["Output is stable.", "The focused test passes."],
      validation: ["npm run test:tooling"],
      ownedPaths: ["scripts/lib/validation-order.mjs"],
      logicalLocks: ["tooling-validation"],
      hostLane: "linux",
      lane: "runtime-neutral",
      requiresOwnerReview: false,
      behavioral: false,
      releaseOrMigrationRisk: false,
    });
  });

  it("ignores malformed machine qualification values instead of guessing", () => {
    expect(
      parseDebtIssueBody(`### Host lane
somewhere

### Work lane
magic

### Behavioral
perhaps

### Dependencies
- #42
- not-an-issue
`),
    ).toEqual({ dependencies: [42] });
  });
});
