import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const reviewerRuntimeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  accountId: z.string().min(1),
  codexExecutable: z.string().startsWith("/"),
  codexHome: z.string().startsWith("/"),
  homeDirectory: z.string().startsWith("/"),
  model: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("replace-with-"), {
      message: "reviewer model placeholder must be replaced",
    }),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  quotaSampleIntervalMs: z.number().int().min(5_000).max(120_000),
});

export type ReviewerRuntimeConfig = z.infer<
  typeof reviewerRuntimeConfigSchema
>;

export async function loadReviewerRuntimeConfig(
  file: string,
): Promise<ReviewerRuntimeConfig> {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file) {
    throw new Error("Reviewer runtime config must be one absolute physical file.");
  }
  const stats = await lstat(file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > 64 * 1_024 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("Reviewer runtime config must be a protected physical file.");
  }
  const config = reviewerRuntimeConfigSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  for (const [value, label, kind] of [
    [config.codexExecutable, "Codex executable", "file"],
    [config.codexHome, "Codex home", "directory"],
    [config.homeDirectory, "Reviewer home", "directory"],
  ] as const) {
    if ((await realpath(value)) !== value) {
      throw new Error(`${label} cannot contain symbolic links.`);
    }
    const valueStats = await lstat(value);
    if (
      valueStats.isSymbolicLink() ||
      (kind === "file" &&
        (!valueStats.isFile() || (valueStats.mode & 0o111) === 0)) ||
      (kind === "directory" && !valueStats.isDirectory()) ||
      (kind === "file" && (valueStats.mode & 0o022) !== 0) ||
      (kind === "directory" && (valueStats.mode & 0o077) !== 0)
    ) {
      throw new Error(`${label} must be one protected physical ${kind}.`);
    }
  }
  return config;
}
