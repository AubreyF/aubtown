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
import type {
  CheckpointStore,
  EncryptedCheckpointPayload,
} from "./store.js";
import {
  assertCheckpointReference,
  checkpointReference,
  decodeCheckpoint,
  encodeCheckpoint,
  MAX_STORED_CHECKPOINT_BYTES,
} from "./codec.js";

export class LocalCheckpointStore implements CheckpointStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Checkpoint store root must be absolute.");
    }
  }

  async put(payload: EncryptedCheckpointPayload): Promise<string> {
    await this.#ensureDirectory(this.root);
    const bytes = encodeCheckpoint(payload);
    const reference = checkpointReference(bytes);
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
    assertCheckpointReference(reference);
    let bytes: Uint8Array;
    try {
      bytes = await this.#readExact(this.#path(reference));
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    if (checkpointReference(bytes) !== reference) {
      throw new Error("Stored checkpoint digest does not match its reference.");
    }
    return decodeCheckpoint(bytes);
  }

  async retire(reference: string, retiredAt: string): Promise<void> {
    assertCheckpointReference(reference);
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
    assertCheckpointReference(reference);
    return path.join(this.root, `${reference}.checkpoint`);
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
    if (stats.size > MAX_STORED_CHECKPOINT_BYTES) {
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
