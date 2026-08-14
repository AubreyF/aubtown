import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
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

export async function writeProtectedJsonFile(input: {
  readonly file: string;
  readonly label: string;
  readonly value: unknown;
}): Promise<void> {
  if (!path.isAbsolute(input.file)) {
    throw new Error(`${input.label} path must be absolute.`);
  }
  const directory = path.dirname(input.file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`${input.label} parent must be a physical directory.`);
  }
  await chmod(directory, 0o700);
  if ((await realpath(directory)) !== directory) {
    throw new Error(`${input.label} parent cannot contain symbolic links.`);
  }
  const temporary = path.join(
    directory,
    `.${path.basename(input.file)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(input.value)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, input.file);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
