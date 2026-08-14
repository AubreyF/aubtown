import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import { loadPublisherRuntime } from "../config/publisher-runtime.js";
import { sshTransportProofSchema } from "../security/ssh-worker-policy.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const physicalFileSchema = z.object({
  path: z.string().startsWith("/"),
  sha256: digestSchema,
}).strict();

export const publisherReadinessReportSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  checkedAt: z.iso.datetime(),
  ready: z.literal(true),
  runtime: physicalFileSchema,
  publisher: physicalFileSchema,
  git: z.object({
    executable: z.string().startsWith("/"),
    version: z.string().min(1),
  }).strict(),
  node: z.object({
    executable: z.string().startsWith("/"),
    version: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
  }).strict(),
  privateKey: z.object({
    path: z.string().startsWith("/"),
    ownerUid: z.number().int().nonnegative(),
    mode: z.literal("0600"),
  }).strict(),
  selectedRepositories: z.array(
    z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  ).min(1),
  worktreeRoots: z.array(z.string().startsWith("/")).min(1),
}).strict();

export type PublisherReadinessReport = z.infer<
  typeof publisherReadinessReportSchema
>;

export const selectedPublisherReadinessReportSchema =
  publisherReadinessReportSchema.extend({
    transport: sshTransportProofSchema,
  });

export type SelectedPublisherReadinessReport = z.infer<
  typeof selectedPublisherReadinessReportSchema
>;

async function physicalFile(input: {
  readonly file: string;
  readonly label: string;
  readonly executable: boolean;
  readonly maxBytes?: number;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const physical = await realpath(input.file);
  const stats = await lstat(input.file);
  if (
    physical !== input.file ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > (input.maxBytes ?? 64 * 1_024 * 1_024) ||
    (stats.mode & 0o022) !== 0 ||
    (input.executable && (stats.mode & 0o111) === 0)
  ) {
    throw new Error(`${input.label} must be one protected physical file.`);
  }
  return {
    path: physical,
    sha256: createHash("sha256").update(await readFile(physical)).digest("hex"),
  };
}

export async function probePublisherReadiness(input: {
  readonly runtimeFile: string;
  readonly publisherFile: string;
  readonly runner: CommandRunner;
  readonly checkedAt: string;
  readonly runningNodeExecutable?: string;
  readonly runningNodeVersion?: string;
  readonly processUid?: number;
}): Promise<PublisherReadinessReport> {
  const runtime = await loadPublisherRuntime(input.runtimeFile);
  const runtimeProof = await physicalFile({
    file: input.runtimeFile,
    label: "Publisher runtime config",
    executable: false,
    maxBytes: 64 * 1_024,
  });
  const publisher = await physicalFile({
    file: input.publisherFile,
    label: "Draft publisher entrypoint",
    executable: false,
    maxBytes: 2 * 1_024 * 1_024,
  });
  const node = await physicalFile({
    file: runtime.nodeExecutable,
    label: "Publisher Node executable",
    executable: true,
    maxBytes: 256 * 1_024 * 1_024,
  });
  const runningNode = await realpath(
    input.runningNodeExecutable ?? process.execPath,
  );
  const runningVersion = input.runningNodeVersion ?? process.version;
  if (runningNode !== node.path || runningVersion !== runtime.nodeVersion) {
    throw new Error("Publisher probe is not running under the configured Node runtime.");
  }
  const git = await physicalFile({
    file: runtime.gitExecutable,
    label: "Publisher Git executable",
    executable: true,
  });
  const worktreeRoots: string[] = [];
  for (const configured of runtime.worktreeRoots) {
    const physical = await realpath(configured);
    const stats = await lstat(configured);
    if (physical !== configured || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Publisher worktree root must be one physical directory.");
    }
    await access(physical, constants.R_OK | constants.X_OK);
    worktreeRoots.push(physical);
  }
  const gitVersion = (
    await input.runner.run({
      executable: git.path,
      args: ["--version"],
      cwd: worktreeRoots[0]!,
      env: {},
    })
  ).stdout.trim();
  const processUid = input.processUid ?? process.getuid?.();
  if (processUid === undefined) {
    throw new Error("Publisher probe cannot determine its OS user identity.");
  }
  const keyPhysical = await realpath(runtime.privateKeyFile);
  const keyStats = await lstat(runtime.privateKeyFile);
  if (
    keyPhysical !== runtime.privateKeyFile ||
    !keyStats.isFile() ||
    keyStats.isSymbolicLink() ||
    keyStats.size < 1 ||
    keyStats.size > 64 * 1_024 ||
    (keyStats.mode & 0o777) !== 0o600 ||
    keyStats.uid !== processUid
  ) {
    throw new Error(
      "Draft Publisher private key must be a mode-0600 physical file owned by the publisher account.",
    );
  }
  return publisherReadinessReportSchema.parse({
    schemaVersion: 1,
    hostId: runtime.hostId,
    checkedAt: z.iso.datetime().parse(input.checkedAt),
    ready: true,
    runtime: runtimeProof,
    publisher,
    git: { executable: git.path, version: gitVersion },
    node: { executable: node.path, version: runningVersion },
    privateKey: {
      path: keyPhysical,
      ownerUid: keyStats.uid,
      mode: "0600",
    },
    selectedRepositories: runtime.selectedRepositories,
    worktreeRoots,
  });
}
