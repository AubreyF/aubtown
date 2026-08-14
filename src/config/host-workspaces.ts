import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HostEnrollments } from "../security/host-enrollment.js";

export type HostWorkspaceRoots = Readonly<Record<string, string>>;

const hostIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const rootsSchema = z.record(
  hostIdSchema,
  z.string().refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      value !== path.parse(value).root,
    { message: "must be one normalized non-root absolute path" },
  ),
);

export function parseHostWorkspaceRoots(
  value: unknown,
  enrollments: HostEnrollments,
): HostWorkspaceRoots {
  const roots = rootsSchema.parse(value);
  for (const hostId of Object.keys(roots)) {
    if (enrollments[hostId]?.enabled !== true) {
      throw new Error(
        `Host workspace root names an unavailable enrollment: ${hostId}.`,
      );
    }
  }
  for (const [hostId, enrollment] of Object.entries(enrollments)) {
    if (enrollment.enabled && roots[hostId] === undefined) {
      throw new Error(`Enabled host lacks a workspace root: ${hostId}.`);
    }
  }
  return Object.fromEntries(
    Object.entries(roots).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function loadHostWorkspaceRoots(
  file: string,
  enrollments: HostEnrollments,
): Promise<HostWorkspaceRoots> {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file) {
    throw new Error("Host workspace roots path must be one absolute physical file.");
  }
  const stats = await lstat(file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > 64 * 1_024 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("Host workspace roots must be a protected physical file.");
  }
  return parseHostWorkspaceRoots(
    JSON.parse(await readFile(file, "utf8")),
    enrollments,
  );
}
