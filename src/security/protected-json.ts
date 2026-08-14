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
import { canonicalJsonEqual } from "./canonical-json.js";

function isAlreadyPresent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "EEXIST"
  );
}

async function prepareProtectedDirectory(
  directory: string,
  label: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`${label} parent must be a physical directory.`);
  }
  await chmod(directory, 0o700);
  if ((await realpath(directory)) !== directory) {
    throw new Error(`${label} parent cannot contain symbolic links.`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

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
  await prepareProtectedDirectory(directory, input.label);
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
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeImmutableProtectedJsonFile(input: {
  readonly file: string;
  readonly label: string;
  readonly value: unknown;
}): Promise<void> {
  if (!path.isAbsolute(input.file)) {
    throw new Error(`${input.label} path must be absolute.`);
  }
  const directory = path.dirname(input.file);
  await prepareProtectedDirectory(directory, input.label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(input.file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(input.value)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (!isAlreadyPresent(error)) {
      throw error;
    }
    const existing = await loadProtectedJsonFile({
      file: input.file,
      label: input.label,
    });
    if (!canonicalJsonEqual(existing, input.value)) {
      throw new Error(`${input.label} conflicts with immutable content.`);
    }
    return;
  } finally {
    await handle?.close();
  }
  await syncDirectory(directory);
}
