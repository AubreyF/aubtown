import { z } from "zod";
import {
  TrustedCompletionReceiptStore,
  trustedCompletionReceiptSchema,
  trustedCompletionReference,
  type TrustedCompletionReceipt,
} from "./completion-receipt.js";
import {
  ExecutorHandoffManifestStore,
  executorHandoffManifestDigest,
  executorHandoffManifestSchema,
  type ExecutorHandoffManifest,
} from "./handoff-manifest.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const trustedCompletionBundleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("trusted-completion-bundle"),
  manifestDigest: digestSchema,
  completionReference: digestSchema,
  manifest: executorHandoffManifestSchema,
  receipt: trustedCompletionReceiptSchema,
});

export type TrustedCompletionBundle = z.infer<
  typeof trustedCompletionBundleSchema
>;

function assertReceiptMatchesManifest(
  receipt: TrustedCompletionReceipt,
  manifest: ExecutorHandoffManifest,
  manifestDigest: string,
): void {
  const binding = manifest.binding;
  if (
    receipt.manifestDigest !== manifestDigest ||
    receipt.repository.owner !== binding.repository.owner ||
    receipt.repository.name !== binding.repository.name ||
    receipt.repository.defaultBranch !== binding.repository.defaultBranch ||
    receipt.issueNumber !== binding.issueNumber ||
    receipt.claimId !== binding.claimId ||
    receipt.custodyEpoch !== binding.custodyEpoch ||
    receipt.hostId !== binding.hostId ||
    receipt.workerId !== binding.workerId ||
    receipt.worktree !== binding.worktree ||
    receipt.branch !== binding.branch ||
    receipt.authorityTaskId !== binding.handoff.authorityTaskId ||
    receipt.accountId !== binding.handoff.accountId ||
    receipt.driverId !== binding.handoff.driverId ||
    receipt.baseHead !== binding.baseHead ||
    receipt.finalizationNonce !== binding.handoff.finalizationNonce
  ) {
    throw new Error("Trusted completion receipt changes executor handoff custody.");
  }
}

export function assertTrustedCompletionBundle(
  value: unknown,
): TrustedCompletionBundle {
  const bundle = trustedCompletionBundleSchema.parse(value);
  if (executorHandoffManifestDigest(bundle.manifest) !== bundle.manifestDigest) {
    throw new Error("Trusted completion bundle changes its manifest digest.");
  }
  assertReceiptMatchesManifest(
    bundle.receipt,
    bundle.manifest,
    bundle.manifestDigest,
  );
  if (trustedCompletionReference(bundle.receipt) !== bundle.completionReference) {
    throw new Error("Trusted completion bundle changes its completion reference.");
  }
  return bundle;
}

export class TrustedCompletionBundleStore {
  constructor(private readonly handoffRoot: string) {}

  async load(manifestDigest: string): Promise<TrustedCompletionBundle | null> {
    const digest = digestSchema.parse(manifestDigest);
    const receipt = await new TrustedCompletionReceiptStore(
      this.handoffRoot,
    ).load(digest);
    if (receipt === null) {
      return null;
    }
    const { manifest } = await new ExecutorHandoffManifestStore(
      this.handoffRoot,
    ).loadByDigest(digest);
    return assertTrustedCompletionBundle({
      schemaVersion: 1,
      kind: "trusted-completion-bundle",
      manifestDigest: digest,
      completionReference: trustedCompletionReference(receipt),
      manifest,
      receipt,
    });
  }
}
