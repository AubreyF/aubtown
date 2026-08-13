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
  ) {}

  async capture(input: {
    readonly claim: DispatchClaim;
    readonly repositoryRoot: string;
    readonly baseRef: string;
    readonly validationReceipts: readonly string[];
    readonly keyReference: string;
    readonly createdAt: string;
  }): Promise<CapturedCheckpoint> {
    const repositoryHead = await this.#gitLine(input.repositoryRoot, ["rev-parse", "HEAD"]);
    const baseHead = await this.#gitLine(input.repositoryRoot, [
      "merge-base",
      "HEAD",
      input.baseRef,
    ]);
    const patch = (
      await this.runner.run({
        executable: "git",
        args: ["diff", "--binary", "--full-index", baseHead, "--", "."],
        cwd: input.repositoryRoot,
        maxBufferBytes: MAX_ARCHIVE_BYTES,
      })
    ).stdout;
    const untrackedOutput = (
      await this.runner.run({
        executable: "git",
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
    const encrypted = await this.store.get(input.reference);
    if (encrypted === undefined) {
      throw new Error("Checkpoint reference was not found.");
    }
    if (
      encrypted.manifest.claimId !== input.claim.claimId ||
      encrypted.manifest.custodyEpoch + 1 !== input.claim.custodyEpoch
    ) {
      throw new Error("Checkpoint does not authorize this destination custody epoch.");
    }
    const archiveBytes = await this.cipher.decrypt(encrypted);
    const archive = archiveSchema.parse(
      JSON.parse(new TextDecoder().decode(archiveBytes)),
    );
    const destinationHead = await this.#gitLine(input.destinationRoot, [
      "rev-parse",
      "HEAD",
    ]);
    if (destinationHead !== archive.baseHead) {
      throw new Error("Destination worktree is not based on the checkpoint base head.");
    }
    const status = (
      await this.runner.run({
        executable: "git",
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
          executable: "git",
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
    return encrypted.manifest;
  }

  async #gitLine(root: string, args: readonly string[]): Promise<string> {
    const value = (
      await this.runner.run({ executable: "git", args, cwd: root })
    ).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(value)) {
      throw new Error(`Git did not return one SHA for ${args.join(" ")}.`);
    }
    return value;
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
