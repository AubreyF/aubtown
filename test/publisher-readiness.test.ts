import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { probePublisherReadiness } from "../src/publication/publisher-readiness.js";

const roots: string[] = [];
const gitExecutable = process.env.AUBTOWN_TEST_GIT_EXECUTABLE ?? "/usr/bin/git";

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Publisher readiness tests require a POSIX user identity.");
  }
  return uid;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

async function fixture(): Promise<{
  readonly runtime: string;
  readonly publisher: string;
  readonly key: string;
  readonly node: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-publisher-readiness-")),
  );
  roots.push(root);
  const runtime = path.join(root, "publisher-runtime.json");
  const publisher = path.join(root, "publish-draft-local.js");
  const key = path.join(root, "publisher.pem");
  const worktrees = path.join(root, "worktrees");
  const node = await realpath(process.execPath);
  await mkdir(worktrees, { mode: 0o700 });
  await writeFile(publisher, "export {};\n", { mode: 0o600 });
  await writeFile(key, "-----BEGIN PRIVATE KEY-----\ntest\n", { mode: 0o600 });
  await writeFile(
    runtime,
    `${JSON.stringify({
      schemaVersion: 1,
      hostId: "linux-control-1",
      gitExecutable: await realpath(gitExecutable),
      nodeExecutable: node,
      nodeVersion: process.version,
      appId: "123",
      installationId: 456,
      privateKeyFile: key,
      selectedRepositories: ["freed-project/freed"],
      worktreeRoots: [worktrees],
    })}\n`,
    { mode: 0o600 },
  );
  return { runtime, publisher, key, node };
}

describe("publisher readiness", () => {
  it("proves the dedicated runtime, key owner, tools, entrypoint, and roots", async () => {
    const prepared = await fixture();
    await expect(
      probePublisherReadiness({
        runtimeFile: prepared.runtime,
        publisherFile: prepared.publisher,
        runner: new ProcessCommandRunner(),
        checkedAt: "2026-08-14T13:00:00.000Z",
        runningNodeExecutable: prepared.node,
        runningNodeVersion: process.version,
        processUid: currentUid(),
      }),
    ).resolves.toMatchObject({
      ready: true,
      hostId: "linux-control-1",
      selectedRepositories: ["freed-project/freed"],
      privateKey: { path: prepared.key, mode: "0600" },
      publisher: { path: prepared.publisher },
    });
  });

  it("rejects a publisher key exposed to another OS user", async () => {
    const prepared = await fixture();
    await chmod(prepared.key, 0o640);
    await expect(
      probePublisherReadiness({
        runtimeFile: prepared.runtime,
        publisherFile: prepared.publisher,
        runner: new ProcessCommandRunner(),
        checkedAt: "2026-08-14T13:00:00.000Z",
        runningNodeExecutable: prepared.node,
        runningNodeVersion: process.version,
        processUid: currentUid(),
      }),
    ).rejects.toThrow("mode-0600");
  });
});
