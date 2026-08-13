import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { LocalCheckpointStore } from "../src/checkpoints/local-store.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import type { CheckpointKeyProvider } from "../src/checkpoints/store.js";
import { claim } from "./helpers.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

function keyProvider(key: Uint8Array): CheckpointKeyProvider {
  return {
    resolve: async (reference) => {
      if (reference !== "keyring:checkpoint-v1") {
        throw new Error("Unknown key reference.");
      }
      return key;
    },
  };
}

function manifest() {
  return createCheckpointManifest({
    claim: claim(),
    repositoryHead: "a".repeat(40),
    baseHead: "b".repeat(40),
    patch: new TextEncoder().encode("diff --git a/file b/file\n"),
    includedUntrackedPaths: ["notes/receipt.json"],
    validationReceipts: ["focused-test:passed"],
    createdAt: "2026-08-13T18:00:00.000Z",
  });
}

describe("encrypted checkpoint storage", () => {
  it("round-trips an authenticated archive and stores no plaintext", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "freedworks-checkpoint-"));
    temporaryRoots.push(root);
    const archive = new TextEncoder().encode("unpublished source work");
    const cipher = new XChaChaCheckpointCipher(
      keyProvider(randomBytes(32)),
      () => new Uint8Array(24).fill(7),
    );
    const encrypted = await cipher.encrypt({
      manifest: manifest(),
      archive,
      keyReference: "keyring:checkpoint-v1",
    });
    const store = new LocalCheckpointStore(root);
    const reference = await store.put(encrypted);
    expect(await store.put(encrypted)).toBe(reference);
    const stored = await store.get(reference);
    expect(stored).toBeDefined();
    await expect(cipher.decrypt(stored!)).resolves.toEqual(archive);
    const raw = await readFile(path.join(root, `${reference}.checkpoint`), "utf8");
    expect(raw).not.toContain("unpublished source work");
  });

  it("rejects manifest tampering through authenticated associated data", async () => {
    const cipher = new XChaChaCheckpointCipher(
      keyProvider(randomBytes(32)),
      () => new Uint8Array(24).fill(9),
    );
    const encrypted = await cipher.encrypt({
      manifest: manifest(),
      archive: new Uint8Array([1, 2, 3]),
      keyReference: "keyring:checkpoint-v1",
    });
    await expect(
      cipher.decrypt({
        ...encrypted,
        manifest: { ...encrypted.manifest, custodyEpoch: 2 },
      }),
    ).rejects.toThrow();
  });

  it("retires checkpoints without deleting retained evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "freedworks-checkpoint-"));
    temporaryRoots.push(root);
    const cipher = new XChaChaCheckpointCipher(
      keyProvider(randomBytes(32)),
      () => new Uint8Array(24).fill(3),
    );
    const store = new LocalCheckpointStore(root);
    const reference = await store.put(
      await cipher.encrypt({
        manifest: manifest(),
        archive: new Uint8Array([4, 5, 6]),
        keyReference: "keyring:checkpoint-v1",
      }),
    );
    await store.retire(reference, "2026-08-14T18:00:00.000Z");
    await expect(store.get(reference)).resolves.toBeUndefined();
    const retiredNames = await readdir(path.join(root, ".retired"));
    expect(retiredNames).toHaveLength(1);
    expect(retiredNames[0]).toMatch(new RegExp(`^${reference}\\.[0-9a-f]{16}\\.retired$`, "u"));
    const retired = await readFile(path.join(root, ".retired", retiredNames[0]!));
    expect(retired.length).toBeGreaterThan(0);
  });
});
