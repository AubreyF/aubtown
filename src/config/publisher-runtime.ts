import path from "node:path";
import { z } from "zod";
import { loadProtectedJsonFile } from "../security/protected-json.js";

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const publisherRuntimeSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  gitExecutable: z.string().refine(path.isAbsolute, "must be absolute"),
  appId: z.union([z.string().min(1), z.number().int().positive()]),
  installationId: z.number().int().positive(),
  privateKeyFile: z.string().refine(path.isAbsolute, "must be absolute"),
  selectedRepositories: z.array(repository).min(1),
}).strict();

export type PublisherRuntime = z.infer<typeof publisherRuntimeSchema>;

export async function loadPublisherRuntime(file: string): Promise<PublisherRuntime> {
  if (!path.isAbsolute(file)) {
    throw new Error("Publisher runtime path must be absolute.");
  }
  return publisherRuntimeSchema.parse(
    await loadProtectedJsonFile({
      file,
      label: "Publisher runtime",
      maxBytes: 64 * 1_024,
    }),
  );
}
