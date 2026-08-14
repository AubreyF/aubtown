import path from "node:path";
import { z } from "zod";
import {
  loadProtectedJsonFile,
  writeProtectedJsonFile,
} from "../../security/protected-json.js";
import { canonicalJsonEqual } from "../../security/canonical-json.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const symphonyActiveTurnRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("symphony-active-turn"),
  manifestDigest: digestSchema,
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.literal(1),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  accountId: z.string().min(1),
  driverId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  observedAt: z.iso.datetime(),
});

export type SymphonyActiveTurnRecord = z.infer<
  typeof symphonyActiveTurnRecordSchema
>;

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}

function stableIdentity(record: SymphonyActiveTurnRecord): unknown {
  const { threadId: _threadId, turnId: _turnId, observedAt: _observedAt, ...stable } =
    record;
  return stable;
}

export class SymphonyActiveTurnJournal {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Symphony active-turn root must be absolute.");
    }
  }

  async record(value: SymphonyActiveTurnRecord): Promise<SymphonyActiveTurnRecord> {
    const next = symphonyActiveTurnRecordSchema.parse(value);
    const current = await this.load(next.manifestDigest);
    if (current !== null) {
      if (!canonicalJsonEqual(stableIdentity(current), stableIdentity(next))) {
        throw new Error("Symphony active turn changes admitted custody.");
      }
      if (Date.parse(next.observedAt) < Date.parse(current.observedAt)) {
        throw new Error("Symphony active-turn observation cannot move backward.");
      }
      if (
        next.observedAt === current.observedAt &&
        (next.threadId !== current.threadId || next.turnId !== current.turnId)
      ) {
        throw new Error("Symphony active turn conflicts at one observation time.");
      }
    }
    await writeProtectedJsonFile({
      file: this.#path(next.manifestDigest),
      label: "Symphony active-turn record",
      value: next,
    });
    return next;
  }

  async load(manifestDigest: string): Promise<SymphonyActiveTurnRecord | null> {
    const digest = digestSchema.parse(manifestDigest);
    try {
      return symphonyActiveTurnRecordSchema.parse(
        await loadProtectedJsonFile({
          file: this.#path(digest),
          label: "Symphony active-turn record",
        }),
      );
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  #path(manifestDigest: string): string {
    return path.join(this.root, `active-turn-${manifestDigest}.json`);
  }
}
