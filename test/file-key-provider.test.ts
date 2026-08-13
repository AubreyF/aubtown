import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileCheckpointKeyProvider } from "../src/checkpoints/file-key-provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("FileCheckpointKeyProvider", () => {
  it("reads only the configured physical mode-restricted 32-byte key", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-checkpoint-key-"));
    roots.push(root);
    const file = join(root, "checkpoint-key.bin");
    const key = Buffer.alloc(32, 7);
    await writeFile(file, key, { mode: 0o600 });
    const provider = new FileCheckpointKeyProvider(file, "pilot:checkpoint-v1");

    await expect(provider.resolve("pilot:checkpoint-v1")).resolves.toEqual(key);
    await expect(provider.resolve("pilot:checkpoint-v2")).rejects.toThrow(
      "not configured",
    );
    await chmod(file, 0o640);
    await expect(provider.resolve("pilot:checkpoint-v1")).rejects.toThrow(
      "group or other users",
    );
  });
});
