import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CustodyCheckpoint } from "../domain/types.js";
import type {
  CheckpointStore,
  EncryptedCheckpointPayload,
} from "./store.js";

const MAX_CHECKPOINT_FILE_BYTES = 512 * 1024 * 1024;
const REFERENCE_PATTERN = /^[0-9a-f]{64}$/u;

const manifestSchema: z.ZodType<CustodyCheckpoint> = z.object({
  schemaVersion: z.literal(1),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  sourceHostId: z.string().min(1),
  repositoryHead: z.string().regex(/^[0-9a-f]{40}$/u),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  patchDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  includedUntrackedPaths: z.array(z.string()),
  validationReceipts: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

const storedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: manifestSchema,
  ciphertextBase64: z.string(),
  nonceBase64: z.string(),
  algorithm: z.literal("xchacha20-poly1305"),
  keyReference: z.string().min(1),
});

function serialized(payload: EncryptedCheckpointPayload): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      schemaVersion: 1,
      manifest: payload.manifest,
      ciphertextBase64: Buffer.from(payload.ciphertext).toString("base64"),
      nonceBase64: Buffer.from(payload.nonce).toString("base64"),
      algorithm: payload.algorithm,
      keyReference: payload.keyReference,
    })}\n`,
  );
}

function referenceFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LocalCheckpointStore implements CheckpointStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Checkpoint store root must be absolute.");
    }
  }

  async put(payload: EncryptedCheckpointPayload): Promise<string> {
    await this.#ensureDirectory(this.root);
    const bytes = serialized(payload);
    if (bytes.length > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error("Encrypted checkpoint exceeds the local store size limit.");
    }
    const reference = referenceFor(bytes);
    const destination = this.#path(reference);
    try {
      const current = await this.#readExact(destination);
      if (!Buffer.from(current).equals(bytes)) {
        throw new Error("Checkpoint reference collides with different bytes.");
      }
      return reference;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    const temporary = path.join(this.root, `.${reference}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
      await this.#syncDirectory(this.root);
    } catch (error) {
      const current = await this.#readExact(destination).catch(() => undefined);
      if (current === undefined || !Buffer.from(current).equals(bytes)) {
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return reference;
  }

  async get(reference: string): Promise<EncryptedCheckpointPayload | undefined> {
    this.#assertReference(reference);
    let bytes: Uint8Array;
    try {
      bytes = await this.#readExact(this.#path(reference));
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    if (referenceFor(bytes) !== reference) {
      throw new Error("Stored checkpoint digest does not match its reference.");
    }
    const parsed = storedPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      manifest: parsed.manifest,
      ciphertext: Buffer.from(parsed.ciphertextBase64, "base64"),
      nonce: Buffer.from(parsed.nonceBase64, "base64"),
      algorithm: parsed.algorithm,
      keyReference: parsed.keyReference,
    };
  }

  async retire(reference: string, retiredAt: string): Promise<void> {
    this.#assertReference(reference);
    if (!Number.isFinite(Date.parse(retiredAt))) {
      throw new Error("Checkpoint retirement timestamp must be valid ISO time.");
    }
    const source = this.#path(reference);
    const retirementRoot = path.join(this.root, ".retired");
    await this.#ensureDirectory(retirementRoot);
    const timestampDigest = createHash("sha256").update(retiredAt).digest("hex").slice(0, 16);
    const destination = path.join(retirementRoot, `${reference}.${timestampDigest}.retired`);
    try {
      await this.#readExact(source);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await this.#readExact(destination);
      return;
    }
    try {
      await rename(source, destination);
      await this.#syncDirectory(this.root);
      await this.#syncDirectory(retirementRoot);
    } catch (error) {
      try {
        await this.#readExact(destination);
      } catch {
        throw error;
      }
    }
  }

  #path(reference: string): string {
    this.#assertReference(reference);
    return path.join(this.root, `${reference}.checkpoint`);
  }

  #assertReference(reference: string): void {
    if (!REFERENCE_PATTERN.test(reference)) {
      throw new Error("Checkpoint reference must be a lowercase SHA-256 digest.");
    }
  }

  async #ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Checkpoint path is not a physical directory: ${directory}`);
    }
    await chmod(directory, 0o700);
  }

  async #readExact(file: string): Promise<Uint8Array> {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Checkpoint entry is not a physical regular file: ${file}`);
    }
    if (stats.size > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error("Stored checkpoint exceeds the local store size limit.");
    }
    return await readFile(file);
  }

  async #syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
