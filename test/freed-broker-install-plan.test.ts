import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { planFreedBrokerInstallation } from "../src/deployment/freed-broker-install-plan.js";
import {
  createReleaseManifest,
  writeReleaseManifest,
} from "../src/deployment/release-manifest.js";

const roots: string[] = [];
const freedCommit = "a".repeat(40);
const aubtownCommit = "b".repeat(40);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(): { readonly uid: number; readonly gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Broker installation tests require POSIX identity.");
  }
  return { uid, gid };
}

class FixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  head = freedCommit;
  status = "";

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args[0] === "rev-parse") {
      return { stdout: `${this.head}\n`, stderr: "" };
    }
    if (request.args[0] === "status") {
      return { stdout: this.status, stderr: "" };
    }
    throw new Error(`Unexpected command: ${request.args.join(" ")}`);
  }
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly runner: FixtureRunner;
  readonly input: Parameters<typeof planFreedBrokerInstallation>[0];
  readonly runtimeFile: string;
}> {
  const fixtureParent = path.join(process.cwd(), ".aubtown");
  await mkdir(fixtureParent, { recursive: true, mode: 0o700 });
  await chmod(fixtureParent, 0o700);
  const root = await realpath(
    await mkdtemp(path.join(fixtureParent, "broker-install-plan-")),
  );
  roots.push(root);
  const freedRoot = path.join(root, "opt", "freed", "control", freedCommit);
  const releaseRoot = path.join(
    root,
    "opt",
    "aubtown",
    "releases",
    aubtownCommit,
  );
  const nodeExecutable = path.join(root, "opt", "aubtown", "node", "node");
  const brokerDestination = path.join(
    root,
    "installed",
    "opt",
    "freed",
    "bin",
    "factory-coordinator",
  );
  const profileDestination = path.join(
    root,
    "installed",
    "etc",
    "aubtown",
    "freed-broker-profiles",
    "freed-pilot.json",
  );
  const runtimeFiles = [
    "scripts/automation-actors.mjs",
    "scripts/automation-control.mjs",
    "scripts/lib/automation-control.mjs",
    "scripts/lib/automation-actor-readiness.mjs",
    "scripts/lib/automation-kernel-guard-cutover.mjs",
  ];
  for (const file of runtimeFiles) {
    const absolute = path.join(freedRoot, file);
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, `export const fixture = ${JSON.stringify(file)};\n`, {
      mode: 0o644,
    });
  }
  const broker = path.join(releaseRoot, "dist", "factory-coordinator");
  await mkdir(path.dirname(broker), { recursive: true, mode: 0o755 });
  await writeFile(broker, "fixture broker\n", { mode: 0o755 });
  const manifest = await createReleaseManifest({
    root: releaseRoot,
    commit: aubtownCommit,
    platform: "linux",
    architecture: "x64",
    nodeVersion: "v24.14.1",
  });
  await writeReleaseManifest({ root: releaseRoot, manifest });
  await mkdir(path.dirname(nodeExecutable), { recursive: true, mode: 0o755 });
  await writeFile(nodeExecutable, "fixture node\n", { mode: 0o755 });
  const runner = new FixtureRunner();
  return {
    root,
    runner,
    runtimeFile: path.join(freedRoot, runtimeFiles[0]!),
    input: {
      runner,
      gitExecutable: "/usr/bin/git",
      trustedUid: identity().uid,
      expectedPlatform: "linux",
      expectedArchitecture: "x64",
      expectedNodeVersion: "v24.14.1",
      freedCommit,
      freedRepositoryRoot: freedRoot,
      freedStateRoot: "/var/lib/freed/automation",
      aubtownReleaseRoot: releaseRoot,
      nodeExecutable,
      brokerDestination,
      profileDestination,
    },
  };
}

describe("Freed broker installation plan", () => {
  it("binds one clean reviewed checkout without mutating the host", async () => {
    const value = await fixture();
    const plan = await planFreedBrokerInstallation(value.input);

    expect(plan.mode).toBe("plan");
    expect(plan.freedCommit).toBe(freedCommit);
    expect(plan.aubtownCommit).toBe(aubtownCommit);
    expect(plan.servicesEnabled).toBe(false);
    expect(plan.servicesStarted).toBe(false);
    expect(plan.broker.sha256).toBe(digest("fixture broker\n"));
    expect(plan.profile.document.nodeSha256).toBe(digest("fixture node\n"));
    expect(plan.profile.document.freedRepositoryRoot).toBe(
      value.input.freedRepositoryRoot,
    );
    expect(plan.profile.document.actor).toBe("freed-nightly-runner");
    expect(plan.profile.document.leaseName).toBe("nightly-writer");
    expect(plan.actions).toEqual([
      `install-broker:${value.input.brokerDestination}`,
      `install-profile:${value.input.profileDestination}`,
    ]);
    await expect(lstat(plan.broker.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(plan.profile.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(value.runner.requests.map((request) => request.args[0])).toEqual([
      "rev-parse",
      "status",
    ]);
  });

  it("rejects a checkout with another head or any dirty state", async () => {
    const wrongHead = await fixture();
    wrongHead.runner.head = "c".repeat(40);
    await expect(
      planFreedBrokerInstallation(wrongHead.input),
    ).rejects.toThrow("does not match the reviewed commit");

    const dirty = await fixture();
    dirty.runner.status = "?? unexpected-file\n";
    await expect(planFreedBrokerInstallation(dirty.input)).rejects.toThrow(
      "not clean",
    );
  });

  it("rejects misleading roots and symbolic runtime artifacts", async () => {
    const misleading = await fixture();
    await expect(
      planFreedBrokerInstallation({
        ...misleading.input,
        freedRepositoryRoot: path.dirname(misleading.input.freedRepositoryRoot),
      }),
    ).rejects.toThrow("path must end with its commit");

    const symbolic = await fixture();
    const replacement = `${symbolic.runtimeFile}.replacement`;
    await writeFile(replacement, "replacement\n", { mode: 0o644 });
    await rm(symbolic.runtimeFile);
    await symlink(replacement, symbolic.runtimeFile);
    await expect(
      planFreedBrokerInstallation(symbolic.input),
    ).rejects.toThrow("not protected and physical");
  });

  it("rejects a checkout below writable ancestry", async () => {
    const value = await fixture();
    const writableParent = path.dirname(value.input.freedRepositoryRoot);
    await chmod(writableParent, 0o777);
    await expect(
      planFreedBrokerInstallation(value.input),
    ).rejects.toThrow("not protected and physical");
  });

  it("rejects non-Linux planning and abbreviated commits", async () => {
    const value = await fixture();
    await expect(
      planFreedBrokerInstallation({
        ...value.input,
        expectedPlatform: "darwin",
      }),
    ).rejects.toThrow("supports Linux only");
    await expect(
      planFreedBrokerInstallation({
        ...value.input,
        freedCommit: freedCommit.slice(0, 12),
      }),
    ).rejects.toThrow("lowercase full SHA");
  });
});
