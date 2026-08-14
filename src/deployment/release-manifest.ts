import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const relativePathSchema = z.string().min(1).refine(
  (value) =>
    !path.isAbsolute(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== ".."),
  "Release paths must be normalized relative paths.",
);

const releaseFileSchema = z.object({
  path: relativePathSchema,
  sha256: digestSchema,
  size: z.number().int().nonnegative(),
  mode: z.string().regex(/^0[0-7]{3}$/u),
}).strict();

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal("AubreyF/aubtown"),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  platform: z.string().regex(/^[a-z0-9_-]+$/u),
  architecture: z.string().regex(/^[a-z0-9_-]+$/u),
  nodeVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
  dependencyInstall: z.literal("npm-ci-omit-dev-ignore-scripts"),
  files: z.array(releaseFileSchema).min(1),
}).strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

interface PhysicalReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: string;
  readonly ownerUid: number;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function octalMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function physicalRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root) || (await realpath(root)) !== root) {
    throw new Error("Release root must be one absolute physical directory.");
  }
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Release root must be one physical directory.");
  }
  return root;
}

async function collectFiles(
  root: string,
  directory = root,
  requiredUid?: number,
): Promise<PhysicalReleaseFile[]> {
  const directoryStats = await lstat(directory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    (requiredUid !== undefined &&
      (directoryStats.uid !== requiredUid ||
        (directoryStats.mode & 0o022) !== 0))
  ) {
    throw new Error(`Release directory is not protected: ${directory}`);
  }
  const collected: PhysicalReleaseFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === "release-manifest.json") {
      continue;
    }
    const stats = await lstat(absolute);
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw new Error(`Release contains a symbolic link: ${relative}`);
    }
    if (entry.isDirectory() && stats.isDirectory()) {
      collected.push(...(await collectFiles(root, absolute, requiredUid)));
      continue;
    }
    if (!entry.isFile() || !stats.isFile()) {
      throw new Error(`Release contains a non-file entry: ${relative}`);
    }
    const bytes = await readFile(absolute);
    collected.push({
      path: relative,
      sha256: digest(bytes),
      size: stats.size,
      mode: octalMode(stats.mode),
      ownerUid: stats.uid,
    });
  }
  return collected.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createReleaseManifest(input: {
  readonly root: string;
  readonly commit: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly nodeVersion?: string;
}): Promise<ReleaseManifest> {
  const root = await physicalRoot(input.root);
  const files = await collectFiles(root);
  return releaseManifestSchema.parse({
    schemaVersion: 1,
    repository: "AubreyF/aubtown",
    commit: input.commit,
    platform: input.platform ?? process.platform,
    architecture: input.architecture ?? process.arch,
    nodeVersion: input.nodeVersion ?? process.version,
    dependencyInstall: "npm-ci-omit-dev-ignore-scripts",
    files: files.map(({ ownerUid: _ownerUid, ...file }) => file),
  });
}

export async function writeReleaseManifest(input: {
  readonly root: string;
  readonly manifest: ReleaseManifest;
}): Promise<string> {
  const root = await physicalRoot(input.root);
  const destination = path.join(root, "release-manifest.json");
  const temporary = path.join(root, ".release-manifest.json.tmp");
  const bytes = Buffer.from(`${JSON.stringify(input.manifest)}\n`, "utf8");
  try {
    await writeFile(temporary, bytes, { mode: 0o644, flag: "wx" });
    await chmod(temporary, 0o644);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return digest(bytes);
}

export async function verifyInstalledRelease(input: {
  readonly root: string;
  readonly requiredUid: number;
  readonly expectedPlatform?: string;
  readonly expectedArchitecture?: string;
  readonly expectedNodeVersion?: string;
}): Promise<{ readonly manifest: ReleaseManifest; readonly sha256: string }> {
  const root = await physicalRoot(input.root);
  const manifestFile = path.join(root, "release-manifest.json");
  const manifestStats = await lstat(manifestFile);
  if (
    !manifestStats.isFile() ||
    manifestStats.isSymbolicLink() ||
    manifestStats.uid !== input.requiredUid ||
    (manifestStats.mode & 0o022) !== 0
  ) {
    throw new Error("Release manifest is not a protected physical file.");
  }
  const manifestBytes = await readFile(manifestFile);
  const manifest = releaseManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (
    path.basename(root) !== manifest.commit ||
    manifest.platform !== (input.expectedPlatform ?? process.platform) ||
    manifest.architecture !== (input.expectedArchitecture ?? process.arch) ||
    manifest.nodeVersion !== (input.expectedNodeVersion ?? process.version)
  ) {
    throw new Error("Release identity does not match its installed host or path.");
  }
  const actual = await collectFiles(root, root, input.requiredUid);
  if (actual.length !== manifest.files.length) {
    throw new Error("Release file set differs from its manifest.");
  }
  for (let index = 0; index < actual.length; index += 1) {
    const file = actual[index]!;
    const expected = manifest.files[index]!;
    if (
      file.ownerUid !== input.requiredUid ||
      file.path !== expected.path ||
      file.sha256 !== expected.sha256 ||
      file.size !== expected.size ||
      file.mode !== expected.mode ||
      (Number.parseInt(file.mode, 8) & 0o022) !== 0
    ) {
      throw new Error(`Release file differs from its manifest: ${file.path}`);
    }
  }
  return { manifest, sha256: digest(manifestBytes) };
}

async function copyPhysicalTree(source: string, destination: string): Promise<void> {
  const sourceStats = await lstat(source);
  if (sourceStats.isSymbolicLink()) {
    throw new Error(`Release source cannot be symbolic: ${source}`);
  }
  if (sourceStats.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const entry of await readdir(source)) {
      await copyPhysicalTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!sourceStats.isFile()) {
    throw new Error(`Release source must be a file: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
}

async function normalizeReleaseTree(root: string, directory = root): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stats = await lstat(absolute);
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw new Error(`Installed dependency contains a symbolic link: ${relative}`);
    }
    if (entry.isDirectory()) {
      await normalizeReleaseTree(root, absolute);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release contains a non-file entry: ${relative}`);
    }
    await chmod(absolute, relative === "dist/factory-coordinator" ? 0o755 : 0o644);
  }
}

const releaseSourcePrefixes = ["config/", "deploy/", "docs/", "upstream/"];
const releaseSourceFiles = new Set([
  ".nvmrc",
  "AGENTS.md",
  "README.md",
  "package.json",
  "package-lock.json",
]);

export async function buildReleaseBundle(input: {
  readonly repositoryRoot: string;
  readonly outputParent?: string;
  readonly gitExecutable: string;
  readonly nodeExecutable: string;
  readonly npmCli: string;
  readonly runner: CommandRunner;
}): Promise<{
  readonly root: string;
  readonly manifest: ReleaseManifest;
  readonly manifestSha256: string;
}> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { readonly name?: string };
  if (packageJson.name !== "@aubtown/control-plane") {
    throw new Error("Release source is not the AubTown repository.");
  }
  const git = async (args: readonly string[]) =>
    await input.runner.run({
      executable: input.gitExecutable,
      args,
      cwd: repositoryRoot,
      env: {},
    });
  if ((await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") {
    throw new Error("AubTown release source must be clean.");
  }
  const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("AubTown release commit is invalid.");
  }
  const tracked = (await git(["ls-files", "-z"])).stdout
    .split("\0")
    .filter((file) =>
      file.length > 0 &&
      (releaseSourceFiles.has(file) ||
        releaseSourcePrefixes.some((prefix) => file.startsWith(prefix))),
    );
  const outputParent =
    input.outputParent ?? path.join(repositoryRoot, ".aubtown", "releases");
  const physicalParent = await realpath(
    await mkdir(outputParent, { recursive: true, mode: 0o700 }).then(
      async () => outputParent,
    ),
  );
  const target = path.join(physicalParent, commit);
  if (path.dirname(target) !== physicalParent || path.basename(target) !== commit) {
    throw new Error("AubTown release target is invalid.");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { mode: 0o755 });
  for (const relative of tracked) {
    await copyPhysicalTree(
      path.join(repositoryRoot, relative),
      path.join(target, relative),
    );
  }
  await copyPhysicalTree(path.join(repositoryRoot, "dist"), path.join(target, "dist"));
  await input.runner.run({
    executable: input.nodeExecutable,
    args: [
      input.npmCli,
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    cwd: target,
    env: process.env,
    timeoutMs: 5 * 60_000,
    maxBufferBytes: 4 * 1_024 * 1_024,
  });
  await rm(path.join(target, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  await normalizeReleaseTree(target);
  const manifest = await createReleaseManifest({ root: target, commit });
  const manifestSha256 = await writeReleaseManifest({ root: target, manifest });
  await verifyInstalledRelease({
    root: target,
    requiredUid: process.getuid?.() ?? 0,
  });
  return { root: target, manifest, manifestSha256 };
}
