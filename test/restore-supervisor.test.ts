import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { GitCustodyCheckpointService } from "../src/checkpoints/git-custody.js";
import { LocalCheckpointStore } from "../src/checkpoints/local-store.js";
import { HostRestoreSupervisor } from "../src/execution/restore-supervisor.js";
import type { CustodyRestoreRequirement } from "../src/execution/restore.js";
import { claim } from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await runner.run({ executable: "git", args, cwd })).stdout.trim();
}

describe("HostRestoreSupervisor", () => {
  it("downloads, restores, verifies, and reports the exact next-epoch worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "freedworks-restore-"));
    roots.push(root);
    const source = path.join(root, "source");
    const worktreeRoot = path.join(root, "worktrees");
    const destination = path.join(worktreeRoot, "destination");
    await mkdir(worktreeRoot);
    await runner.run({ executable: "git", args: ["init", "-b", "dev", source], cwd: root });
    await git(source, ["config", "user.name", "Freedworks Test"]);
    await git(source, ["config", "user.email", "test@example.invalid"]);
    await mkdir(path.join(source, "scripts"));
    await writeFile(path.join(source, "scripts", "worktree-add.sh"), "#!/bin/sh\n", {
      mode: 0o700,
    });
    await writeFile(path.join(source, "tracked.txt"), "before\n");
    await git(source, ["add", "tracked.txt", "scripts/worktree-add.sh"]);
    await git(source, ["commit", "-m", "base"]);
    await git(source, ["branch", "origin/dev"]);
    const baseHead = await git(source, ["rev-parse", "HEAD"]);
    await runner.run({ executable: "git", args: ["clone", source, destination], cwd: root });
    await git(destination, ["switch", "-c", "fix/deterministic-validation", baseHead]);
    await git(source, ["switch", "-c", "fix/deterministic-validation", baseHead]);
    await writeFile(path.join(source, "tracked.txt"), "after\n");
    await writeFile(path.join(source, "notes.txt"), "unpublished\n");

    const key = randomBytes(32);
    const cipher = new XChaChaCheckpointCipher({ resolve: async () => key });
    const sourceStore = new LocalCheckpointStore(path.join(root, "source-store"));
    const sourceCustody = new GitCustodyCheckpointService(runner, cipher, sourceStore);
    const sourceClaim = claim({ hostId: "macos-executor-1", worktree: source });
    const captured = await sourceCustody.capture({
      claim: sourceClaim,
      repositoryRoot: source,
      baseRef: "origin/dev",
      validationReceipts: ["worker-turn:interrupted"],
      keyReference: "pilot:checkpoint-v1",
      createdAt: "2026-08-13T18:00:00.000Z",
    });
    const encrypted = await sourceStore.get(captured.reference);
    if (encrypted === undefined) {
      throw new Error("Fixture checkpoint was not stored.");
    }
    const destinationStore = new LocalCheckpointStore(
      path.join(root, "destination-store"),
    );
    const destinationCustody = new GitCustodyCheckpointService(
      runner,
      cipher,
      destinationStore,
    );
    const requirement: CustodyRestoreRequirement = {
      schemaVersion: 1,
      repository: sourceClaim.repository,
      issueNumber: sourceClaim.issueNumber,
      claimId: sourceClaim.claimId,
      priorCustodyEpoch: 1,
      custodyEpoch: 2,
      destinationHostId: "linux-control-1",
      destinationWorkerId: "worker-linux-1",
      destinationWorktree: destination,
      branch: sourceClaim.branch,
      conflictDomains: [...sourceClaim.conflictDomains],
      claimedAt: sourceClaim.claimedAt,
      checkpointReference: captured.reference,
      checkpointContentLength: 1_024,
      checkpointBaseHead: baseHead,
      requiredAt: "2026-08-13T18:00:01.000Z",
    };
    const reports: unknown[] = [];
    const gateway = {
      pollRestore: async () => ({
        kind: "restore-poll" as const,
        hostId: "linux-control-1",
        sequence: 1,
        acceptedAt: "2026-08-13T18:00:02.000Z",
        requirement,
        reason: "required" as const,
      }),
      requestCheckpointGrant: async () => ({}) as never,
      reportRestore: async (receipt: unknown) => {
        reports.push(receipt);
        return {
          kind: "restore-receipt" as const,
          hostId: "linux-control-1",
          sequence: 2,
          acceptedAt: "2026-08-13T18:00:03.000Z",
          claimId: sourceClaim.claimId,
          custodyEpoch: 2,
          checkpointReference: captured.reference,
        };
      },
    };
    const transfer = { download: async () => encrypted };
    const supervisor = new HostRestoreSupervisor(
      source,
      worktreeRoot,
      path.join(source, "scripts", "worktree-add.sh"),
      runner,
      destinationCustody,
      destinationStore,
      transfer as never,
      gateway as never,
      () => new Date("2026-08-13T18:00:03.000Z"),
    );

    await expect(supervisor.reconcile()).resolves.toBe("restored");
    await expect(readFile(path.join(destination, "tracked.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    await expect(readFile(path.join(destination, "notes.txt"), "utf8")).resolves.toBe(
      "unpublished\n",
    );
    expect(reports).toEqual([
      expect.objectContaining({
        checkpointReference: captured.reference,
        checkpointBaseHead: baseHead,
        custodyEpoch: 2,
      }),
    ]);

    const escapedSupervisor = new HostRestoreSupervisor(
      source,
      worktreeRoot,
      path.join(source, "scripts", "worktree-add.sh"),
      runner,
      destinationCustody,
      destinationStore,
      transfer as never,
      {
        ...gateway,
        pollRestore: async () => ({
          kind: "restore-poll" as const,
          hostId: "linux-control-1",
          sequence: 3,
          acceptedAt: "2026-08-13T18:00:04.000Z",
          requirement: {
            ...requirement,
            destinationWorktree: path.join(root, "outside"),
          },
          reason: "required" as const,
        }),
      } as never,
    );
    await expect(escapedSupervisor.reconcile()).rejects.toThrow(
      "escapes the configured host root",
    );
  });
});
