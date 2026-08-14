import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import { verifyInstalledRelease } from "./release-manifest.js";

const commitPattern = /^[0-9a-f]{40}$/u;

const freedRuntimeFiles = {
  automationActorsEntry: "scripts/automation-actors.mjs",
  automationControlEntry: "scripts/automation-control.mjs",
  automationControlLibrary: "scripts/lib/automation-control.mjs",
  actorReadinessLibrary: "scripts/lib/automation-actor-readiness.mjs",
  kernelGuardLibrary: "scripts/lib/automation-kernel-guard-cutover.mjs",
} as const;

type FreedRuntimeKey = keyof typeof freedRuntimeFiles;

export interface FreedBrokerProfile {
  readonly schemaVersion: 1;
  readonly profile: "freed-pilot";
  readonly freedRepositoryRoot: string;
  readonly stateRoot: string;
  readonly nodeExecutable: string;
  readonly nodeSha256: string;
  readonly automationActorsEntry: string;
  readonly automationActorsSha256: string;
  readonly automationControlEntry: string;
  readonly automationControlSha256: string;
  readonly automationControlLibrary: string;
  readonly automationControlLibrarySha256: string;
  readonly actorReadinessLibrary: string;
  readonly actorReadinessLibrarySha256: string;
  readonly kernelGuardLibrary: string;
  readonly kernelGuardLibrarySha256: string;
  readonly actor: "freed-nightly-runner";
  readonly leaseName: "nightly-writer";
}

export interface FreedBrokerInstallPlan {
  readonly schemaVersion: 1;
  readonly mode: "plan";
  readonly freedCommit: string;
  readonly aubtownCommit: string;
  readonly aubtownReleaseManifestSha256: string;
  readonly broker: {
    readonly source: string;
    readonly destination: string;
    readonly sha256: string;
  };
  readonly profile: {
    readonly destination: string;
    readonly sha256: string;
    readonly document: FreedBrokerProfile;
  };
  readonly actions: readonly string[];
  readonly servicesEnabled: false;
  readonly servicesStarted: false;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function requireCanonicalAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be canonical and absolute.`);
  }
}

async function requireProtectedAncestry(
  directory: string,
  trustedUid: number,
): Promise<void> {
  requireCanonicalAbsolute(directory, "Directory");
  let current = directory;
  while (true) {
    const physical = await realpath(current);
    const stats = await lstat(current);
    if (
      physical !== current ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.uid !== 0 && stats.uid !== trustedUid) ||
      (stats.mode & 0o022) !== 0
    ) {
      throw new Error(`Directory is not protected and physical: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function protectedFile(input: {
  readonly file: string;
  readonly trustedUid: number;
  readonly executable?: boolean;
  readonly maxBytes?: number;
}): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  requireCanonicalAbsolute(input.file, "Runtime file");
  await requireProtectedAncestry(path.dirname(input.file), input.trustedUid);
  const physical = await realpath(input.file);
  const stats = await lstat(input.file);
  if (
    physical !== input.file ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== input.trustedUid ||
    (stats.mode & 0o022) !== 0 ||
    (input.executable === true && (stats.mode & 0o100) === 0) ||
    stats.size < 1 ||
    stats.size > (input.maxBytes ?? 16 * 1_024 * 1_024)
  ) {
    throw new Error(`Runtime file is not protected and physical: ${input.file}`);
  }
  const bytes = await readFile(input.file);
  return { bytes, sha256: sha256(bytes) };
}

async function verifyFreedCheckout(input: {
  readonly runner: CommandRunner;
  readonly gitExecutable: string;
  readonly root: string;
  readonly commit: string;
}): Promise<void> {
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: "/nonexistent",
  };
  const head = await input.runner.run({
    executable: input.gitExecutable,
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: input.root,
    env: environment,
    timeoutMs: 10_000,
    maxBufferBytes: 64 * 1_024,
  });
  if (head.stderr.trim() !== "" || head.stdout.trim() !== input.commit) {
    throw new Error("Freed checkout does not match the reviewed commit.");
  }
  const status = await input.runner.run({
    executable: input.gitExecutable,
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: input.root,
    env: environment,
    timeoutMs: 10_000,
    maxBufferBytes: 4 * 1_024 * 1_024,
  });
  if (status.stderr.trim() !== "" || status.stdout.trim() !== "") {
    throw new Error("Freed checkout is not clean at the reviewed commit.");
  }
}

export async function planFreedBrokerInstallation(input: {
  readonly runner: CommandRunner;
  readonly gitExecutable: string;
  readonly trustedUid: number;
  readonly expectedPlatform: string;
  readonly expectedArchitecture: string;
  readonly expectedNodeVersion: string;
  readonly freedCommit: string;
  readonly freedRepositoryRoot: string;
  readonly freedStateRoot: string;
  readonly aubtownReleaseRoot: string;
  readonly nodeExecutable: string;
  readonly brokerDestination: string;
  readonly profileDestination: string;
}): Promise<FreedBrokerInstallPlan> {
  if (input.expectedPlatform !== "linux") {
    throw new Error("The Freed broker installation plan supports Linux only.");
  }
  if (!commitPattern.test(input.freedCommit)) {
    throw new Error("The reviewed Freed commit must be one lowercase full SHA.");
  }
  for (const [label, value] of Object.entries({
    "Git executable": input.gitExecutable,
    "Freed repository root": input.freedRepositoryRoot,
    "Freed state root": input.freedStateRoot,
    "AubTown release root": input.aubtownReleaseRoot,
    "Node executable": input.nodeExecutable,
    "Broker destination": input.brokerDestination,
    "Broker profile destination": input.profileDestination,
  })) {
    requireCanonicalAbsolute(value, label);
  }
  if (path.basename(input.freedRepositoryRoot) !== input.freedCommit) {
    throw new Error("The immutable Freed checkout path must end with its commit.");
  }
  await requireProtectedAncestry(input.freedRepositoryRoot, input.trustedUid);
  await verifyFreedCheckout({
    runner: input.runner,
    gitExecutable: input.gitExecutable,
    root: input.freedRepositoryRoot,
    commit: input.freedCommit,
  });
  const release = await verifyInstalledRelease({
    root: input.aubtownReleaseRoot,
    requiredUid: input.trustedUid,
    expectedPlatform: "linux",
    expectedArchitecture: input.expectedArchitecture,
    expectedNodeVersion: input.expectedNodeVersion,
  });
  const brokerSource = path.join(
    input.aubtownReleaseRoot,
    "dist",
    "factory-coordinator",
  );
  const broker = await protectedFile({
    file: brokerSource,
    trustedUid: input.trustedUid,
    executable: true,
  });
  const node = await protectedFile({
    file: input.nodeExecutable,
    trustedUid: input.trustedUid,
    executable: true,
  });
  const runtime = {} as Record<
    FreedRuntimeKey,
    { readonly path: string; readonly sha256: string }
  >;
  for (const [key, relative] of Object.entries(freedRuntimeFiles) as [
    FreedRuntimeKey,
    string,
  ][]) {
    const file = path.join(input.freedRepositoryRoot, relative);
    const artifact = await protectedFile({
      file,
      trustedUid: input.trustedUid,
    });
    runtime[key] = { path: file, sha256: artifact.sha256 };
  }
  const profile: FreedBrokerProfile = {
    schemaVersion: 1,
    profile: "freed-pilot",
    freedRepositoryRoot: input.freedRepositoryRoot,
    stateRoot: input.freedStateRoot,
    nodeExecutable: input.nodeExecutable,
    nodeSha256: node.sha256,
    automationActorsEntry: runtime.automationActorsEntry.path,
    automationActorsSha256: runtime.automationActorsEntry.sha256,
    automationControlEntry: runtime.automationControlEntry.path,
    automationControlSha256: runtime.automationControlEntry.sha256,
    automationControlLibrary: runtime.automationControlLibrary.path,
    automationControlLibrarySha256: runtime.automationControlLibrary.sha256,
    actorReadinessLibrary: runtime.actorReadinessLibrary.path,
    actorReadinessLibrarySha256: runtime.actorReadinessLibrary.sha256,
    kernelGuardLibrary: runtime.kernelGuardLibrary.path,
    kernelGuardLibrarySha256: runtime.kernelGuardLibrary.sha256,
    actor: "freed-nightly-runner",
    leaseName: "nightly-writer",
  };
  return {
    schemaVersion: 1,
    mode: "plan",
    freedCommit: input.freedCommit,
    aubtownCommit: release.manifest.commit,
    aubtownReleaseManifestSha256: release.sha256,
    broker: {
      source: brokerSource,
      destination: input.brokerDestination,
      sha256: broker.sha256,
    },
    profile: {
      destination: input.profileDestination,
      sha256: sha256(Buffer.from(canonicalJson(profile), "utf8")),
      document: profile,
    },
    actions: [
      `install-broker:${input.brokerDestination}`,
      `install-profile:${input.profileDestination}`,
    ],
    servicesEnabled: false,
    servicesStarted: false,
  };
}
