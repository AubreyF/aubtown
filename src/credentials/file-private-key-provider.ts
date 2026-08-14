import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PrivateKeyProvider } from "./github-app-broker.js";

const MAX_PRIVATE_KEY_BYTES = 64 * 1_024;

export class FilePrivateKeyProvider implements PrivateKeyProvider {
  async resolve(reference: string): Promise<string> {
    if (!path.isAbsolute(reference)) {
      throw new Error("GitHub App private key path must be absolute.");
    }
    if ((await realpath(reference)) !== reference) {
      throw new Error("GitHub App private key path cannot contain symbolic links.");
    }
    const stats = await lstat(reference);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o077) !== 0 ||
      stats.size < 1 ||
      stats.size > MAX_PRIVATE_KEY_BYTES
    ) {
      throw new Error(
        "GitHub App private key must be a nonempty mode-restricted physical file.",
      );
    }
    return await readFile(reference, "utf8");
  }
}
