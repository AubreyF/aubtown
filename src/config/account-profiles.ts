import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import type { HostEnrollments } from "../security/host-enrollment.js";

export interface ExecutionAccountProfile {
  readonly driverId: string;
  readonly enabled: boolean;
  readonly hostIds: readonly string[];
}

export type ExecutionAccountProfiles = Readonly<
  Record<string, ExecutionAccountProfile>
>;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const profileSchema: z.ZodType<ExecutionAccountProfile> = z.object({
  driverId: z.string().min(1),
  enabled: z.boolean(),
  hostIds: z
    .array(idSchema)
    .min(1)
    .transform((ids) => [...new Set(ids)].sort()),
});
const profilesSchema = z.record(idSchema, profileSchema);

export function parseExecutionAccountProfiles(
  value: unknown,
  enrollments: HostEnrollments,
): ExecutionAccountProfiles {
  const profiles = profilesSchema.parse(value);
  for (const [accountId, profile] of Object.entries(profiles)) {
    for (const hostId of profile.hostIds) {
      const enrollment = enrollments[hostId];
      if (enrollment === undefined || !enrollment.enabled) {
        throw new Error(
          `Execution account ${accountId} names an unavailable host enrollment: ${hostId}.`,
        );
      }
      if (!enrollment.accountIds.includes(accountId)) {
        throw new Error(
          `Execution account ${accountId} is outside host enrollment ${hostId}.`,
        );
      }
    }
  }
  return profiles;
}

export async function loadExecutionAccountProfiles(
  environment: NodeJS.ProcessEnv,
  enrollments: HostEnrollments,
): Promise<ExecutionAccountProfiles> {
  const inline = environment.AUBTOWN_ACCOUNT_PROFILES_JSON?.trim();
  const file = environment.AUBTOWN_ACCOUNT_PROFILES_FILE?.trim();
  if (
    inline !== undefined &&
    inline.length > 0 &&
    file !== undefined &&
    file.length > 0
  ) {
    throw new Error("Configure execution account profiles with JSON or a file, not both.");
  }
  if (file !== undefined && file.length > 0) {
    if (!file.startsWith("/")) {
      throw new Error("AUBTOWN_ACCOUNT_PROFILES_FILE must be absolute.");
    }
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_024 * 1_024) {
      throw new Error("Execution account profiles must be a small physical file.");
    }
    return parseExecutionAccountProfiles(
      JSON.parse(await readFile(file, "utf8")),
      enrollments,
    );
  }
  return parseExecutionAccountProfiles(
    JSON.parse(inline === undefined || inline.length === 0 ? "{}" : inline),
    enrollments,
  );
}
