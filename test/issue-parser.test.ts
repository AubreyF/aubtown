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
`);
    expect(parsed).toEqual({
      rootCause: "Unsorted paths cause nondeterministic output.",
      evidence: "The fixture alternates between two orders.",
      scope: "Runtime-neutral tooling only.",
      acceptanceCriteria: ["Output is stable.", "The focused test passes."],
    });
    expect(parsed.validation).toBeUndefined();
  });
});
