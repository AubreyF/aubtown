import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import {
  probePublisherReadiness,
  publisherForcedCommand,
} from "../src/publication/publisher-readiness.js";

const roots: string[] = [];
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
  readonly gateway: string;
  readonly authorizedKeys: string;
  readonly key: string;
  readonly node: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-publisher-readiness-")),
  );
  roots.push(root);
  const runtime = path.join(root, "publisher-runtime.json");
  const publisher = path.join(root, "publish-draft-local.js");
  const gateway = path.join(root, "publisher-ssh-gateway.js");
  const authorizedKeys = path.join(root, "publisher_authorized_keys");
  const git = path.join(root, "git");
  const key = path.join(root, "publisher.pem");
  const worktrees = path.join(root, "worktrees");
  const node = await realpath(process.execPath);
  await mkdir(worktrees, { mode: 0o700 });
  await writeFile(publisher, "export {};\n", { mode: 0o600 });
  await writeFile(gateway, "export {};\n", { mode: 0o600 });
  await writeFile(git, "#!/bin/sh\necho 'git version test'\n", { mode: 0o700 });
  await writeFile(key, "-----BEGIN PRIVATE KEY-----\ntest\n", { mode: 0o600 });
  await writeFile(
    runtime,
    `${JSON.stringify({
      schemaVersion: 1,
      hostId: "linux-control-1",
      gitExecutable: git,
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
  const forcedCommand = publisherForcedCommand({
    nodeExecutable: node,
    gatewayFile: gateway,
    runtimeFile: runtime,
    publisherFile: publisher,
    authorizedKeysFile: authorizedKeys,
  });
  await writeFile(
    authorizedKeys,
    `restrict,command="${forcedCommand}" ssh-ed25519 QUFBQQ== aubtown-coordinator-publisher\n`,
    { mode: 0o600 },
  );
  return { runtime, publisher, gateway, authorizedKeys, key, node };
}

describe("publisher readiness", () => {
  it("proves the dedicated runtime, key owner, tools, entrypoint, and roots", async () => {
    const prepared = await fixture();
    await expect(
      probePublisherReadiness({
        runtimeFile: prepared.runtime,
        publisherFile: prepared.publisher,
        gatewayFile: prepared.gateway,
        authorizedKeysFile: prepared.authorizedKeys,
        runner: new ProcessCommandRunner(),
        checkedAt: "2026-08-14T13:00:00.000Z",
        runningNodeExecutable: prepared.node,
        runningNodeVersion: process.version,
        processUid: currentUid(),
        requiredArtifactUid: currentUid(),
      }),
    ).resolves.toMatchObject({
      ready: true,
      hostId: "linux-control-1",
      selectedRepositories: ["freed-project/freed"],
      privateKey: { path: prepared.key, mode: "0600" },
      publisher: { path: prepared.publisher },
      gateway: { path: prepared.gateway },
      authorizedKeys: { path: prepared.authorizedKeys },
    });
  });

  it("rejects a publisher key exposed to another OS user", async () => {
    const prepared = await fixture();
    await chmod(prepared.key, 0o640);
    await expect(
      probePublisherReadiness({
        runtimeFile: prepared.runtime,
        publisherFile: prepared.publisher,
        gatewayFile: prepared.gateway,
        authorizedKeysFile: prepared.authorizedKeys,
        runner: new ProcessCommandRunner(),
        checkedAt: "2026-08-14T13:00:00.000Z",
        runningNodeExecutable: prepared.node,
        runningNodeVersion: process.version,
        processUid: currentUid(),
        requiredArtifactUid: currentUid(),
      }),
    ).rejects.toThrow("mode-0600");
  });

  it("rejects an unrestricted publisher SSH key", async () => {
    const prepared = await fixture();
    await writeFile(
      prepared.authorizedKeys,
      "ssh-ed25519 QUFBQQ== aubtown-coordinator-publisher\n",
      { mode: 0o600 },
    );
    await expect(
      probePublisherReadiness({
        runtimeFile: prepared.runtime,
        publisherFile: prepared.publisher,
        gatewayFile: prepared.gateway,
        authorizedKeysFile: prepared.authorizedKeys,
        runner: new ProcessCommandRunner(),
        checkedAt: "2026-08-14T13:00:00.000Z",
        runningNodeExecutable: prepared.node,
        runningNodeVersion: process.version,
        processUid: currentUid(),
        requiredArtifactUid: currentUid(),
      }),
    ).rejects.toThrow("exactly one restricted forced-command key");
  });
});
