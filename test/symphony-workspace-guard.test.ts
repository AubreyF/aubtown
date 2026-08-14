import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../src/config/worker-runtime.js";
import { assertPreparedSymphonyWorkspace } from "../src/integrations/symphony/workspace-guard.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();
const gitExecutable = process.env.AUBTOWN_TEST_GIT_EXECUTABLE ?? "/usr/bin/git";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await runner.run({ executable: gitExecutable, args, cwd })).stdout.trim();
}

describe("Symphony workspace guard", () => {
  it("loads worker topology only from a protected physical config file", async () => {
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "aubtown-worker-config-"),
    );
    roots.push(root);
    const configFile = path.join(root, "worker.json");
    const value = {
      schemaVersion: 1,
      hostId: "linux-control-1",
      repositoryRoot: "/srv/freed/repository",
      worktreeRoot: "/var/lib/aubtown/workspaces",
      gitExecutable: "/usr/bin/git",
    } as const;
    await writeFile(configFile, JSON.stringify(value), { mode: 0o600 });
    await expect(loadWorkerRuntimeConfig(configFile)).resolves.toEqual(value);

    await chmod(configFile, 0o622);
    await expect(loadWorkerRuntimeConfig(configFile)).rejects.toThrow(
      "protected physical file",
    );
    await chmod(configFile, 0o600);
    const alias = path.join(root, "alias.json");
    await symlink(configFile, alias);
    await expect(loadWorkerRuntimeConfig(alias)).rejects.toThrow("symbolic links");
  });

  it("accepts only a clean Freed worktree with a policy-safe branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-symphony-workspace-"));
    roots.push(root);
    const repository = path.join(root, "freed");
    const worktreeRoot = path.join(root, "worktrees");
    const workspace = path.join(worktreeRoot, "GH-1234");
    await mkdir(worktreeRoot);
    await runner.run({
      executable: gitExecutable,
      args: ["init", "-b", "dev", repository],
      cwd: root,
    });
    await git(repository, ["config", "user.name", "AubTown Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repository, "tracked.txt"), "base\n");
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-m", "base"]);
    await git(repository, [
      "worktree",
      "add",
      "-b",
      "fix/deterministic-validation",
      workspace,
      "HEAD",
    ]);
    const result = await assertPreparedSymphonyWorkspace({
      workspace,
      config: {
        schemaVersion: 1,
        hostId: "linux-control-1",
        repositoryRoot: repository,
        worktreeRoot,
        gitExecutable,
      },
      runner,
    });
    expect(result.branch).toBe("fix/deterministic-validation");
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(path.join(workspace, "unexpected.txt"), "dirty\n");
    await expect(
      assertPreparedSymphonyWorkspace({
        workspace,
        config: {
          schemaVersion: 1,
          hostId: "linux-control-1",
          repositoryRoot: repository,
          worktreeRoot,
          gitExecutable,
        },
        runner,
      }),
    ).rejects.toThrow("must be clean");
  });

  it("rejects another repository and authorship-signaling branches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-symphony-foreign-"));
    roots.push(root);
    const enrolled = path.join(root, "freed");
    const foreign = path.join(root, "foreign");
    const worktreeRoot = path.join(root, "worktrees");
    const workspace = path.join(worktreeRoot, "GH-1234");
    await mkdir(worktreeRoot);
    for (const repository of [enrolled, foreign]) {
      await runner.run({
        executable: gitExecutable,
        args: ["init", "-b", "dev", repository],
        cwd: root,
      });
      await git(repository, ["config", "user.name", "AubTown Test"]);
      await git(repository, ["config", "user.email", "test@example.invalid"]);
      await writeFile(path.join(repository, "tracked.txt"), "base\n");
      await git(repository, ["add", "tracked.txt"]);
      await git(repository, ["commit", "-m", "base"]);
    }
    await git(foreign, [
      "worktree",
      "add",
      "-b",
      "fix/codex-generated",
      workspace,
      "HEAD",
    ]);
    await expect(
      assertPreparedSymphonyWorkspace({
        workspace,
        config: {
          schemaVersion: 1,
          hostId: "linux-control-1",
          repositoryRoot: enrolled,
          worktreeRoot,
          gitExecutable,
        },
        runner,
      }),
    ).rejects.toThrow("another Git repository");
  });
});
