import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonEqual,
} from "../src/security/canonical-json.js";

describe("canonical JSON", () => {
  it("compares canonical bytes rather than Uint8Array identity", () => {
    const left = { beta: [2, 3], alpha: { enabled: true } };
    const right = { alpha: { enabled: true }, beta: [2, 3] };

    expect(canonicalJson(left)).not.toBe(canonicalJson(right));
    expect(canonicalJsonEqual(left, right)).toBe(true);
    expect(canonicalJsonEqual(left, { ...right, beta: [2, 4] })).toBe(false);
  });
});
