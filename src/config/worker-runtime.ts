import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface WorkerRuntimeConfig {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
  };
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly handoffRoot: string;
  readonly worktreeHelper: string;
  readonly gitExecutable: string;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
}

const absolutePath = z.string().refine((value) => path.isAbsolute(value), {
  message: "must be an absolute path",
});

const configSchema: z.ZodType<WorkerRuntimeConfig> = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  repositoryRoot: absolutePath,
  worktreeRoot: absolutePath,
  handoffRoot: absolutePath,
  worktreeHelper: absolutePath,
  gitExecutable: absolutePath,
  nodeExecutable: absolutePath,
  nodeVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
});

export async function loadWorkerRuntimeConfig(
  file: string,
): Promise<WorkerRuntimeConfig> {
  if (!path.isAbsolute(file)) {
    throw new Error("Worker runtime config path must be absolute.");
  }
  if ((await realpath(file)) !== file) {
    throw new Error(
      "Worker runtime config path cannot contain symbolic links.",
    );
  }
  const stats = await lstat(file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > 64 * 1_024 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("Worker runtime config must be a protected physical file.");
  }
  return configSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
