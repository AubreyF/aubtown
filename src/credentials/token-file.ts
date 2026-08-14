import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function writeInstallationTokenFile(input: {
  readonly destination: string;
  readonly token: string;
}): Promise<void> {
  if (!path.isAbsolute(input.destination)) {
    throw new Error("GitHub installation token destination must be absolute.");
  }
  if (input.token.trim() !== input.token || input.token.length < 1) {
    throw new Error("GitHub installation token must be nonempty and trimmed.");
  }
  const parent = path.dirname(input.destination);
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("GitHub installation token parent must be a physical directory.");
  }
  const physicalParent = await realpath(parent);
  if (physicalParent !== parent) {
    throw new Error("GitHub installation token parent cannot contain symbolic links.");
  }

  const temporary = path.join(
    parent,
    `.${path.basename(input.destination)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${input.token}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, input.destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readInstallationTokenFile(file: string): Promise<string> {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file) {
    throw new Error("GitHub installation token path must be one absolute physical file.");
  }
  const stats = await lstat(file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 2 ||
    stats.size > 16 * 1_024 ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("GitHub installation token must be a protected physical file.");
  }
  const token = (await readFile(file, "utf8")).trim();
  if (token.length < 1 || /\s/u.test(token)) {
    throw new Error("GitHub installation token file is invalid.");
  }
  return token;
}
