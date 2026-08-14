import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSequenceStore } from "../src/security/sequence-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("DurableSequenceStore", () => {
  it("serializes concurrent increments and survives process replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-sequence-"));
    roots.push(root);
    const file = path.join(root, "state", "host.sequence");
    const first = new DurableSequenceStore(file);
    await expect(Promise.all([first.next(), first.next(), first.next()])).resolves.toEqual([1, 2, 3]);
    const replacement = new DurableSequenceStore(file);
    await expect(replacement.next()).resolves.toBe(4);
    await expect(readFile(file, "utf8")).resolves.toBe("4\n");
  });
});
