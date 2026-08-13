import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointKeyProvider } from "./store.js";

export class FileCheckpointKeyProvider implements CheckpointKeyProvider {
  constructor(
    private readonly file: string,
    private readonly keyReference: string,
  ) {
    if (!path.isAbsolute(file)) {
      throw new Error("Checkpoint encryption key path must be absolute.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(keyReference)) {
      throw new Error("Checkpoint key reference is invalid.");
    }
  }

  async resolve(keyReference: string): Promise<Uint8Array> {
    if (keyReference !== this.keyReference) {
      throw new Error("Checkpoint key reference is not configured on this host.");
    }
    const stats = await lstat(this.file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 32) {
      throw new Error("Checkpoint encryption key must be a physical 32-byte file.");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(
        "Checkpoint encryption key cannot be accessible by group or other users.",
      );
    }
    return await readFile(this.file);
  }
}
