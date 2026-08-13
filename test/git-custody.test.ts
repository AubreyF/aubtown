import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { GitCustodyCheckpointService } from "../src/checkpoints/git-custody.js";
import { LocalCheckpointStore } from "../src/checkpoints/local-store.js";
import { claim } from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await runner.run({ executable: "git", args, cwd })).stdout.trim();
}

describe("GitCustodyCheckpointService", () => {
  it("moves tracked and approved untracked work into a clean next-epoch worktree", async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), "freedworks-git-custody-"));
    roots.push(testRoot);
    const source = path.join(testRoot, "source");
    const destination = path.join(testRoot, "destination");
    const storeRoot = path.join(testRoot, "store");
    await runner.run({ executable: "git", args: ["init", "-b", "dev", source], cwd: testRoot });
    await git(source, ["config", "user.name", "Freedworks Test"]);
    await git(source, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(source, "tracked.txt"), "before\n");
    await git(source, ["add", "tracked.txt"]);
    await git(source, ["commit", "-m", "base"]);
    await git(source, ["branch", "origin/dev"]);
    const baseHead = await git(source, ["rev-parse", "HEAD"]);
    await runner.run({ executable: "git", args: ["clone", source, destination], cwd: testRoot });
    await writeFile(path.join(source, "tracked.txt"), "after\n");
    await writeFile(path.join(source, "notes.txt"), "unpublished\n");

    const key = randomBytes(32);
    const cipher = new XChaChaCheckpointCipher({ resolve: async () => key });
    const service = new GitCustodyCheckpointService(
      runner,
      cipher,
      new LocalCheckpointStore(storeRoot),
    );
    const originalClaim = claim({ worktree: source, hostId: "macos-executor-1" });
    const captured = await service.capture({
      claim: originalClaim,
      repositoryRoot: source,
      baseRef: "origin/dev",
      validationReceipts: ["test:pass"],
      keyReference: "keyring:test",
      createdAt: "2026-08-13T18:00:00.000Z",
    });
    expect(captured.manifest.baseHead).toBe(baseHead);

    await service.restore({
      reference: captured.reference,
      claim: {
        ...originalClaim,
        custodyEpoch: 2,
        hostId: "linux-control-1",
        workerId: "worker-linux-1",
        worktree: destination,
      },
      destinationRoot: destination,
    });
    await expect(readFile(path.join(destination, "tracked.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    await expect(readFile(path.join(destination, "notes.txt"), "utf8")).resolves.toBe(
      "unpublished\n",
    );
    expect(await git(destination, ["diff", "--cached", "--name-only"])).toContain(
      "tracked.txt",
    );
  });
});
