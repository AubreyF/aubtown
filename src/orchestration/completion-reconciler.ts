import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AuthorityBridge } from "../adapters/authority.js";
import type { FreedClaimShowReceipt } from "../adapters/freed/claim-broker.js";
import { createAdjudicationCommand } from "../adjudication/command.js";
import type { ReviewedValidationProfile } from "../adjudication/validation-profile.js";
import { resolveReviewedValidationCommands } from "../adjudication/validation-profile.js";
import { workProductFromSymphonyCompletion } from "../adjudication/symphony-work-product.js";
import type { IssueRecord } from "../domain/types.js";
import type { AccountUsageSnapshot } from "../domain/types.js";
import type { TrustedCompletionReader } from "../execution/remote-completion-reader.js";
import {
  executorHandoffManifestDigest,
  executorHandoffManifestFromRequirement,
} from "../execution/handoff-manifest.js";
import type { SymphonyActiveTurnJournal } from "../integrations/symphony/active-turn-journal.js";
import {
  symphonyAdmissionEnvelopeSchema,
  type SymphonyAdmissionEnvelope,
} from "../integrations/symphony/admission-envelope.js";
import { symphonyWorkspaceRequirementFromBinding } from "../integrations/symphony/prepare-admission.js";
import { canonicalJson, canonicalJsonEqual } from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeImmutableProtectedJsonFile,
} from "../security/protected-json.js";
import { adjudicationCommandSchema } from "../adjudication/command.js";
import { accountUsageSnapshotSchema } from "../domain/schemas.js";
import { decideQuota } from "../policy/quota.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const completionReconciliationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("completion-reconciled"),
  manifestDigest: digestSchema,
  completionReference: digestSchema,
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  authorityClaimId: z.string().min(1),
  currentHeartbeatAt: z.iso.datetime(),
  reconciledAt: z.iso.datetime(),
  command: adjudicationCommandSchema,
});

export type CompletionReconciliation = z.infer<
  typeof completionReconciliationSchema
>;

export interface CurrentFreedClaimSource {
  show(input: {
    readonly schemaVersion: 1;
    readonly taskId: string;
  }): Promise<FreedClaimShowReceipt>;
}

function deterministicUuid(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function currentFreedClaimMatchesEnvelope(
  envelope: SymphonyAdmissionEnvelope,
  current: FreedClaimShowReceipt,
): boolean {
  const binding = envelope.binding;
  const expected = binding.claim;
  const claim = current.claim;
  return (
    current.taskRevision === binding.authorityTask.revision &&
    current.bindingDigest === envelope.admission.bindingDigest &&
    claim !== null &&
    claim.claimId === expected.claimId &&
    claim.githubIssue.number === binding.authorityTask.githubIssue.number &&
    claim.githubIssue.url === binding.authorityTask.githubIssue.url &&
    claim.custodyEpoch === expected.custodyEpoch &&
    claim.hostId === expected.hostId &&
    claim.workerId === expected.workerId &&
    claim.branch === expected.branch &&
    claim.worktree === expected.worktree &&
    canonicalJsonEqual(
      [...claim.conflictDomains].sort(),
      [...expected.conflictDomains].sort(),
    ) &&
    claim.claimedAt === expected.claimedAt &&
    claim.baseHead === binding.baseHead &&
    claim.accountId === binding.accountId &&
    claim.driverId === binding.driverId &&
    claim.target === binding.target &&
    claim.workLane === binding.qualification.workLane &&
    claim.publicationCeiling === "draft-pr" &&
    claim.executionStage === "running"
  );
}

export function assertIssueEligibleForCompletion(
  expected: IssueRecord,
  current: IssueRecord,
): void {
  if (
    current.number !== expected.number ||
    current.url !== expected.url ||
    current.state !== "open" ||
    !current.labels.includes("factory:ready") ||
    current.labels.includes("factory:blocked")
  ) {
    throw new Error("GitHub issue is no longer eligible for adjudication.");
  }
}

export class SymphonyCompletionReconciler {
  constructor(
    private readonly completions: TrustedCompletionReader,
    private readonly authority: Pick<AuthorityBridge, "inspect">,
    private readonly claims: CurrentFreedClaimSource,
    private readonly activeTurns: Pick<SymphonyActiveTurnJournal, "load">,
  ) {}

  async reconcile(input: {
    readonly envelope: SymphonyAdmissionEnvelope;
    readonly currentIssue: IssueRecord;
    readonly usage: AccountUsageSnapshot;
    readonly validationProfile: ReviewedValidationProfile;
    readonly now: string;
  }): Promise<CompletionReconciliation | null> {
    const envelope = symphonyAdmissionEnvelopeSchema.parse(input.envelope);
    const now = z.iso.datetime().parse(input.now);
    const usage = accountUsageSnapshotSchema.parse(input.usage);
    if (usage.accountId !== envelope.binding.accountId) {
      throw new Error("Completion reconciliation received another quota account.");
    }
    const expectedManifest = executorHandoffManifestFromRequirement(
      symphonyWorkspaceRequirementFromBinding({
        binding: envelope.binding,
        requiredAt: envelope.preparedAt,
      }),
    );
    const manifestDigest = executorHandoffManifestDigest(expectedManifest);
    const bundle = await this.completions.read({
      hostId: envelope.selectedHost.id,
      manifestDigest,
    });
    if (bundle === null) {
      return null;
    }
    const quota = decideQuota({ snapshot: usage, now });
    if (quota.action !== "admit" && quota.action !== "throttle") {
      throw new Error(`Completion adjudication is blocked by quota: ${quota.reason}.`);
    }
    assertIssueEligibleForCompletion(
      envelope.binding.qualification.issue,
      input.currentIssue,
    );
    if (!canonicalJsonEqual(bundle.manifest, expectedManifest)) {
      throw new Error("Trusted completion does not match the admitted manifest.");
    }
    if (Date.parse(bundle.receipt.completedAt) > Date.parse(now)) {
      throw new Error("Trusted completion is future-dated.");
    }
    const inspection = await this.authority.inspect(
      envelope.binding.qualification,
    );
    const task = inspection.task;
    if (
      !inspection.active ||
      task === undefined ||
      task.id !== envelope.binding.authorityTask.id ||
      task.revision !== envelope.binding.authorityTask.revision ||
      task.githubIssue.number !== envelope.binding.authorityTask.githubIssue.number ||
      task.githubIssue.url !== envelope.binding.authorityTask.githubIssue.url ||
      task.executionAuthority !==
        envelope.binding.authorityTask.executionAuthority ||
      task.providerAuthority !== envelope.binding.authorityTask.providerAuthority ||
      task.behavioral !== envelope.binding.authorityTask.behavioral
    ) {
      throw new Error("Freed task authority changed before adjudication.");
    }
    const currentClaim = await this.claims.show({
      schemaVersion: 1,
      taskId: envelope.admission.taskId,
    });
    if (!currentFreedClaimMatchesEnvelope(envelope, currentClaim)) {
      throw new Error("Freed execution claim changed before adjudication.");
    }
    const implementation = await this.activeTurns.load(manifestDigest);
    if (implementation === null) {
      throw new Error("Symphony implementation turn identity is missing.");
    }
    const workProduct = workProductFromSymphonyCompletion({
      bundle,
      implementation,
    });
    const command = createAdjudicationCommand({
      commandId: deterministicUuid({
        domain: "aubtown.completion-adjudication.v1",
        completionReference: bundle.completionReference,
      }),
      workProduct,
      qualification: envelope.binding.qualification,
      accountId: envelope.binding.accountId,
      usageAtAdmission: usage,
      reviewerDriverId: "codex-app-server-review-v1",
      validationCommands: resolveReviewedValidationCommands({
        profile: input.validationProfile,
        qualification: envelope.binding.qualification,
      }),
      issuedAt: now,
    });
    return completionReconciliationSchema.parse({
      schemaVersion: 1,
      kind: "completion-reconciled",
      manifestDigest,
      completionReference: bundle.completionReference,
      taskId: task.id,
      taskRevision: task.revision,
      authorityClaimId: currentClaim.claim?.claimId,
      currentHeartbeatAt: currentClaim.claim?.heartbeatAt,
      reconciledAt: now,
      command,
    });
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}

function stableReconciliation(value: CompletionReconciliation): unknown {
  const { reconciledAt: _reconciledAt, ...stable } = value;
  const {
    issuedAt: _issuedAt,
    usageAtAdmission: _usageAtAdmission,
    ...stableCommand
  } = stable.command;
  return { ...stable, command: stableCommand };
}

export class CompletionReconciliationStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Completion reconciliation root must be absolute.");
    }
  }

  async publish(
    value: CompletionReconciliation,
  ): Promise<CompletionReconciliation> {
    const reconciliation = completionReconciliationSchema.parse(value);
    const current = await this.load(reconciliation.manifestDigest);
    if (current !== null) {
      if (
        !canonicalJsonEqual(
          stableReconciliation(current),
          stableReconciliation(reconciliation),
        )
      ) {
        throw new Error(
          "Completion reconciliation conflicts with prior coordinator state.",
        );
      }
      return current;
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path(reconciliation.manifestDigest),
      label: "Completion reconciliation",
      value: reconciliation,
    });
    return reconciliation;
  }

  async load(manifestDigest: string): Promise<CompletionReconciliation | null> {
    const digest = digestSchema.parse(manifestDigest);
    try {
      return completionReconciliationSchema.parse(
        await loadProtectedJsonFile({
          file: this.#path(digest),
          label: "Completion reconciliation",
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
    return path.join(this.root, `completion-${manifestDigest}.json`);
  }
}
