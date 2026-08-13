import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import type { HostLane } from "../domain/types.js";

export interface HostEnrollment {
  readonly enabled: boolean;
  readonly lane: HostLane;
  readonly accountIds: readonly string[];
  readonly publicKeyPem: string;
}

export type HostEnrollments = Readonly<Record<string, HostEnrollment>>;

const hostIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const enrollmentSchema: z.ZodType<HostEnrollment> = z.object({
  enabled: z.boolean(),
  lane: z.enum(["linux", "macos"]),
  accountIds: z.array(z.string().min(1)).transform((ids) => [...new Set(ids)].sort()),
  publicKeyPem: z.string().includes("BEGIN PUBLIC KEY"),
});
const enrollmentsSchema = z.record(hostIdSchema, enrollmentSchema);

export function parseHostEnrollments(value: unknown): HostEnrollments {
  return enrollmentsSchema.parse(value);
}

export async function loadHostEnrollments(environment: NodeJS.ProcessEnv): Promise<HostEnrollments> {
  const inline = environment.FREEDWORKS_HOST_ENROLLMENTS_JSON?.trim();
  const file = environment.FREEDWORKS_HOST_ENROLLMENTS_FILE?.trim();
  if (inline !== undefined && inline.length > 0 && file !== undefined && file.length > 0) {
    throw new Error("Configure host enrollments with JSON or a file, not both.");
  }
  if (file !== undefined && file.length > 0) {
    if (!file.startsWith("/")) {
      throw new Error("FREEDWORKS_HOST_ENROLLMENTS_FILE must be absolute.");
    }
    return parseHostEnrollments(JSON.parse(await readFile(file, "utf8")));
  }
  return parseHostEnrollments(JSON.parse(inline === undefined || inline.length === 0 ? "{}" : inline));
}

export async function loadHostPrivateKey(file: string): Promise<string> {
  if (!file.startsWith("/")) {
    throw new Error("Host private key path must be absolute.");
  }
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1_024) {
    throw new Error("Host private key must be a small physical file.");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Host private key cannot be readable or writable by group or other users.");
  }
  return await readFile(file, "utf8");
}
