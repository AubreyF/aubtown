import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export async function loadProtectedJsonFile(input: {
  readonly file: string;
  readonly label: string;
  readonly maxBytes?: number;
}): Promise<unknown> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  if (!path.isAbsolute(input.file) || (await realpath(input.file)) !== input.file) {
    throw new Error(`${input.label} must be one absolute physical file.`);
  }
  const stats = await lstat(input.file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > maxBytes ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(`${input.label} must be a protected physical file.`);
  }
  return JSON.parse(await readFile(input.file, "utf8")) as unknown;
}
