import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { GitExecutionCandidateFinalizer } from "../src/execution/candidate-finalizer.js";
import { createExecutorStartCommand } from "../src/execution/command.js";
import { claim, report } from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();
const finalizationNonce = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await runner.run({ executable: "git", args, cwd })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "freedworks-finalizer-"));
  roots.push(root);
  await runner.run({ executable: "git", args: ["init", "-b", "dev", root], cwd: root });
  await git(root, ["config", "user.name", "Freedworks Test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "owned.txt"), "before\n");
  await git(root, ["add", "owned.txt"]);
  await git(root, ["commit", "-m", "base"]);
  const baseHead = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["branch", "origin/dev"]);
  await git(root, ["switch", "-c", "fix/deterministic-validation"]);
  const command = createExecutorStartCommand({
    commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
    claim: claim({
      worktree: root,
      conflictDomains: ["logical:tooling-validation", "path:owned.txt"],
    }),
    qualification: report({ ownedPaths: ["owned.txt"] }),
    authorityTaskId: "github-issue-1234",
    accountId: "codex-pro-1",
    baseHead,
    issuedAt: "2026-08-13T18:00:00.000Z",
  });
  return { root, command };
}

describe("GitExecutionCandidateFinalizer", () => {
  it("creates one bounded local commit and accepts an exact crash retry", async () => {
    const { root, command } = await fixture();
    await writeFile(join(root, "owned.txt"), "after\n");
    await git(root, ["branch", "-D", "origin/dev"]);
    const finalizer = new GitExecutionCandidateFinalizer(runner, "git");
    const first = await finalizer.finalize(command, finalizationNonce);
    const second = await finalizer.finalize(command, finalizationNonce);
    expect(second).toEqual(first);
    expect(await git(root, ["status", "--porcelain=v1"])).toBe("");
    expect(await git(root, ["show", "-s", "--format=%s", first.head])).toBe(
      "fix: resolve issue #1234",
    );
    expect(
      await git(root, ["rev-list", "--count", `${command.baseHead}..HEAD`]),
    ).toBe("1");
    expect(await git(root, ["show", "-s", "--format=%B", first.head])).toBe(
      `fix: resolve issue #1234\n\nExecution-Receipt: ${finalizationNonce}`,
    );
  });

  it("rejects changes outside qualified ownership", async () => {
    const { root, command } = await fixture();
    await writeFile(join(root, "outside.txt"), "not owned\n");
    await expect(
      new GitExecutionCandidateFinalizer(runner, "git").finalize(
        command,
        finalizationNonce,
      ),
    ).rejects.toThrow("outside qualified ownership");
  });

  it("rejects worker-created commits", async () => {
    const { root, command } = await fixture();
    await writeFile(join(root, "owned.txt"), "after\n");
    await git(root, ["add", "owned.txt"]);
    await git(root, ["commit", "-m", "fix: resolve issue #1234"]);
    await expect(
      new GitExecutionCandidateFinalizer(runner, "git").finalize(
        command,
        finalizationNonce,
      ),
    ).rejects.toThrow("trusted finalizer commit");
  });
});
