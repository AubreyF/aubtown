import { createHash } from "node:crypto";
import { mkdir, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { CustodyCheckpoint, DispatchClaim } from "../domain/types.js";
import { isCheckpointPathAllowed } from "../policy/custody.js";
import type { CheckpointCipher, CheckpointStore } from "./store.js";
import { createCheckpointManifest } from "./manifest.js";

const MAX_ARCHIVE_BYTES = 256 * 1_024 * 1_024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1_024 * 1_024;

const archiveSchema = z.object({
  schemaVersion: z.literal(1),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  repositoryHead: z.string().regex(/^[0-9a-f]{40}$/u),
  patch: z.string(),
  untracked: z.array(
    z.object({
      path: z.string(),
      contentBase64: z.string(),
      executable: z.boolean(),
    }),
  ),
});

type GitCheckpointArchive = z.infer<typeof archiveSchema>;

export interface CapturedCheckpoint {
  readonly reference: string;
  readonly manifest: CustodyCheckpoint;
}

export class GitCustodyCheckpointService {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cipher: CheckpointCipher,
    private readonly store: CheckpointStore,
    private readonly gitExecutable = "git",
  ) {}

  async capture(input: {
    readonly claim: DispatchClaim;
    readonly repositoryRoot: string;
    readonly baseRef: string;
    readonly validationReceipts: readonly string[];
    readonly keyReference: string;
    readonly createdAt: string;
  }): Promise<CapturedCheckpoint> {
    await this.#assertBranch(input.repositoryRoot, input.claim.branch);
    const repositoryHead = await this.#gitLine(input.repositoryRoot, ["rev-parse", "HEAD"]);
    const baseHead = await this.#gitLine(input.repositoryRoot, [
      "merge-base",
      "HEAD",
      input.baseRef,
    ]);
    const patch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["diff", "--binary", "--full-index", baseHead, "--", "."],
        cwd: input.repositoryRoot,
        maxBufferBytes: MAX_ARCHIVE_BYTES,
      })
    ).stdout;
    const untrackedOutput = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["ls-files", "--others", "--exclude-standard", "-z"],
        cwd: input.repositoryRoot,
        maxBufferBytes: 16 * 1_024 * 1_024,
      })
    ).stdout;
    const untrackedPaths = untrackedOutput
      .split("\0")
      .filter(Boolean)
      .sort();
    const untracked: GitCheckpointArchive["untracked"] = [];
    for (const relativePath of untrackedPaths) {
      if (!isCheckpointPathAllowed(relativePath)) {
        throw new Error(`Checkpoint path is forbidden: ${relativePath}`);
      }
      const absolutePath = await this.#physicalRepositoryFile(
        input.repositoryRoot,
        relativePath,
      );
      const stats = await lstat(absolutePath);
      if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
        throw new Error(`Untracked checkpoint file is too large: ${relativePath}`);
      }
      untracked.push({
        path: relativePath,
        contentBase64: (await readFile(absolutePath)).toString("base64"),
        executable: (stats.mode & 0o100) !== 0,
      });
    }
    const archive: GitCheckpointArchive = {
      schemaVersion: 1,
      baseHead,
      repositoryHead,
      patch,
      untracked,
    };
    const archiveBytes = new TextEncoder().encode(JSON.stringify(archive));
    if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
      throw new Error("Checkpoint archive exceeds the custody size limit.");
    }
    const manifest = createCheckpointManifest({
      claim: input.claim,
      repositoryHead,
      baseHead,
      patch: archiveBytes,
      includedUntrackedPaths: untrackedPaths,
      validationReceipts: input.validationReceipts,
      createdAt: input.createdAt,
    });
    const encrypted = await this.cipher.encrypt({
      manifest,
      archive: archiveBytes,
      keyReference: input.keyReference,
    });
    return { reference: await this.store.put(encrypted), manifest };
  }

  async restore(input: {
    readonly reference: string;
    readonly claim: DispatchClaim;
    readonly destinationRoot: string;
  }): Promise<CustodyCheckpoint> {
    const { manifest, archive } = await this.#readAuthorizedArchive(
      input.reference,
      input.claim,
    );
    await this.#assertBranch(input.destinationRoot, input.claim.branch);
    const destinationHead = await this.#gitLine(input.destinationRoot, [
      "rev-parse",
      "HEAD",
    ]);
    if (destinationHead !== archive.baseHead) {
      throw new Error("Destination worktree is not based on the checkpoint base head.");
    }
    const status = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: input.destinationRoot,
      })
    ).stdout;
    if (status.trim() !== "") {
      throw new Error("Destination worktree must be clean before checkpoint restore.");
    }
    if (archive.patch.length > 0) {
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "freedworks-patch-"));
      try {
        const patchPath = path.join(temporaryRoot, "custody.patch");
        await writeFile(patchPath, archive.patch, { flag: "wx", mode: 0o600 });
        await this.runner.run({
          executable: this.gitExecutable,
          args: ["apply", "--binary", "--index", patchPath],
          cwd: input.destinationRoot,
          timeoutMs: 60_000,
        });
      } finally {
        await rm(temporaryRoot, { recursive: true });
      }
    }
    for (const entry of archive.untracked) {
      if (!isCheckpointPathAllowed(entry.path)) {
        throw new Error(`Checkpoint restore path is forbidden: ${entry.path}`);
      }
      const destination = path.join(input.destinationRoot, entry.path);
      const parent = path.dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const physicalRoot = await realpath(input.destinationRoot);
      const physicalParent = await realpath(parent);
      if (
        physicalParent !== physicalRoot &&
        !physicalParent.startsWith(`${physicalRoot}${path.sep}`)
      ) {
        throw new Error(`Checkpoint restore escapes the worktree: ${entry.path}`);
      }
      const handle = await open(destination, "wx", entry.executable ? 0o700 : 0o600);
      try {
        await handle.writeFile(Buffer.from(entry.contentBase64, "base64"));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.verifyRestored(input);
    return manifest;
  }

  async verifyRestored(input: {
    readonly reference: string;
    readonly claim: DispatchClaim;
    readonly destinationRoot: string;
  }): Promise<CustodyCheckpoint> {
    const { manifest, archive } = await this.#readAuthorizedArchive(
      input.reference,
      input.claim,
    );
    await this.#assertBranch(input.destinationRoot, input.claim.branch);
    const destinationHead = await this.#gitLine(input.destinationRoot, [
      "rev-parse",
      "HEAD",
    ]);
    if (destinationHead !== archive.baseHead) {
      throw new Error("Restored worktree is not based on the checkpoint base head.");
    }
    const patch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["diff", "--binary", "--full-index", archive.baseHead, "--", "."],
        cwd: input.destinationRoot,
        maxBufferBytes: MAX_ARCHIVE_BYTES,
      })
    ).stdout;
    if (patch !== archive.patch) {
      throw new Error("Restored tracked work does not match the checkpoint archive.");
    }
    const untrackedOutput = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["ls-files", "--others", "--exclude-standard", "-z"],
        cwd: input.destinationRoot,
        maxBufferBytes: 16 * 1_024 * 1_024,
      })
    ).stdout;
    const actualPaths = untrackedOutput.split("\0").filter(Boolean).sort();
    const expectedPaths = archive.untracked.map((entry) => entry.path).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error("Restored untracked paths do not match the checkpoint archive.");
    }
    for (const entry of archive.untracked) {
      const file = await this.#physicalRepositoryFile(
        input.destinationRoot,
        entry.path,
      );
      const stats = await lstat(file);
      const content = await readFile(file);
      if (
        content.toString("base64") !== entry.contentBase64 ||
        ((stats.mode & 0o100) !== 0) !== entry.executable
      ) {
        throw new Error(`Restored file does not match its checkpoint: ${entry.path}`);
      }
    }
    return manifest;
  }

  async #readAuthorizedArchive(
    reference: string,
    claim: DispatchClaim,
  ): Promise<{ readonly manifest: CustodyCheckpoint; readonly archive: GitCheckpointArchive }> {
    const encrypted = await this.store.get(reference);
    if (encrypted === undefined) {
      throw new Error("Checkpoint reference was not found.");
    }
    if (
      encrypted.manifest.repository.owner !== claim.repository.owner ||
      encrypted.manifest.repository.name !== claim.repository.name ||
      encrypted.manifest.repository.defaultBranch !== claim.repository.defaultBranch ||
      encrypted.manifest.issueNumber !== claim.issueNumber ||
      encrypted.manifest.claimId !== claim.claimId ||
      encrypted.manifest.custodyEpoch + 1 !== claim.custodyEpoch
    ) {
      throw new Error("Checkpoint does not authorize this destination custody epoch.");
    }
    const archiveBytes = await this.cipher.decrypt(encrypted);
    if (
      createHash("sha256").update(archiveBytes).digest("hex") !==
      encrypted.manifest.patchDigest
    ) {
      throw new Error("Checkpoint archive digest does not match its manifest.");
    }
    const archive = archiveSchema.parse(
      JSON.parse(new TextDecoder().decode(archiveBytes)),
    );
    return { manifest: encrypted.manifest, archive };
  }

  async #gitLine(root: string, args: readonly string[]): Promise<string> {
    const value = (
      await this.runner.run({ executable: this.gitExecutable, args, cwd: root })
    ).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(value)) {
      throw new Error(`Git did not return one SHA for ${args.join(" ")}.`);
    }
    return value;
  }

  async #assertBranch(root: string, expected: string): Promise<void> {
    const branch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: root,
      })
    ).stdout.trim();
    if (branch !== expected) {
      throw new Error("Checkpoint worktree is checked out on another branch.");
    }
  }

  async #physicalRepositoryFile(root: string, relativePath: string): Promise<string> {
    const physicalRoot = await realpath(root);
    const candidate = path.join(root, relativePath);
    const physical = await realpath(candidate);
    if (!physical.startsWith(`${physicalRoot}${path.sep}`)) {
      throw new Error(`Checkpoint file escapes the worktree: ${relativePath}`);
    }
    const stats = await lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Checkpoint entry is not a physical regular file: ${relativePath}`);
    }
    return candidate;
  }
}
