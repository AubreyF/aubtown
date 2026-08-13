import { describe, expect, it } from "vitest";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { claim } from "./helpers.js";

describe("checkpoint manifest", () => {
  it("binds repository identity, custody, patch bytes, and sorted receipts", () => {
    const manifest = createCheckpointManifest({
      claim: claim(),
      repositoryHead: "a".repeat(40),
      baseHead: "b".repeat(40),
      patch: new TextEncoder().encode("diff --git a/a b/a\n"),
      includedUntrackedPaths: ["src/new.ts", "docs/note.md"],
      validationReceipts: ["typecheck:pass", "tests:pass"],
      createdAt: "2026-08-13T08:00:00.000Z",
    });
    expect(manifest.patchDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.repository).toEqual(claim().repository);
    expect(manifest.issueNumber).toBe(claim().issueNumber);
    expect(manifest.includedUntrackedPaths).toEqual(["docs/note.md", "src/new.ts"]);
    expect(manifest.validationReceipts).toEqual(["tests:pass", "typecheck:pass"]);
  });

  it.each([".env", "auth.json", "keys/app.pem", "../outside"])(
    "rejects secret or escaping path %s",
    (path) => {
      expect(() =>
        createCheckpointManifest({
          claim: claim(),
          repositoryHead: "a".repeat(40),
          baseHead: "b".repeat(40),
          patch: new Uint8Array(),
          includedUntrackedPaths: [path],
          validationReceipts: [],
          createdAt: "2026-08-13T08:00:00.000Z",
        }),
      ).toThrow("Checkpoint path is forbidden");
    },
  );
});
