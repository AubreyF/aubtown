import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface SequenceSource {
  next(): Promise<number>;
}

export class DurableSequenceStore implements SequenceSource {
  #pending: Promise<number> = Promise.resolve(0);

  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) {
      throw new Error("Host sequence file must be absolute.");
    }
  }

  next(): Promise<number> {
    const next = this.#pending.then(async () => await this.#advance());
    this.#pending = next.catch(() => 0);
    return next;
  }

  async #advance(): Promise<number> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Host sequence parent must be a physical directory.");
    }
    await chmod(directory, 0o700);
    let current = 0;
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64) {
        throw new Error("Host sequence state must be a small physical file.");
      }
      const value = (await readFile(this.file, "utf8")).trim();
      current = Number(value);
      if (!Number.isSafeInteger(current) || current < 0) {
        throw new Error("Host sequence state is invalid.");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new Error("Host sequence is exhausted.");
    }
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${next.toLocaleString("en-US", { useGrouping: false })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return next;
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT";
}
