import path from "node:path";
import { z } from "zod";
import { canonicalJsonEqual } from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeImmutableProtectedJsonFile,
} from "../security/protected-json.js";

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const trustedCompletionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("trusted-candidate-finalized"),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.literal(1),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  worktree: z.string().startsWith("/"),
  branch: z.string().min(1),
  authorityTaskId: z.string().min(1),
  accountId: z.string().min(1),
  driverId: z.string().min(1),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  head: z.string().regex(/^[0-9a-f]{40}$/u),
  finalizationNonce: z.uuid(),
  completedAt: z.iso.datetime(),
});

export type TrustedCompletionReceipt = z.infer<
  typeof trustedCompletionReceiptSchema
>;

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}

function stableReceipt(receipt: TrustedCompletionReceipt): unknown {
  const { completedAt: _completedAt, ...stable } = receipt;
  return stable;
}

export class TrustedCompletionReceiptStore {
  constructor(private readonly handoffRoot: string) {
    if (!path.isAbsolute(handoffRoot)) {
      throw new Error("Trusted completion receipt root must be absolute.");
    }
  }

  async record(input: TrustedCompletionReceipt): Promise<TrustedCompletionReceipt> {
    const receipt = trustedCompletionReceiptSchema.parse(input);
    const file = this.#path(receipt.manifestDigest);
    const existing = await this.load(receipt.manifestDigest);
    if (existing !== null) {
      if (!canonicalJsonEqual(stableReceipt(existing), stableReceipt(receipt))) {
        throw new Error("Trusted completion receipt conflicts with prior finalization.");
      }
      return existing;
    }
    await writeImmutableProtectedJsonFile({
      file,
      label: "Trusted completion receipt",
      value: receipt,
    });
    const written = await this.load(receipt.manifestDigest);
    if (written === null || !canonicalJsonEqual(written, receipt)) {
      throw new Error("Trusted completion receipt changed during publication.");
    }
    return written;
  }

  async load(manifestDigest: string): Promise<TrustedCompletionReceipt | null> {
    const digest = z.string().regex(/^[0-9a-f]{64}$/u).parse(manifestDigest);
    try {
      return trustedCompletionReceiptSchema.parse(
        await loadProtectedJsonFile({
          file: this.#path(digest),
          label: "Trusted completion receipt",
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
    return path.join(this.handoffRoot, `completion-${manifestDigest}.json`);
  }
}
