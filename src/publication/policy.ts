import type {
  AuthorityTask,
  DispatchClaim,
  PublicationCeiling,
  QualificationReport,
  RepositoryRef,
} from "../domain/types.js";
import type { QuotaDecision } from "../policy/quota.js";
import { buildStatusProjection, type StatusProjection } from "../projection/status.js";
import {
  assessHandoff,
  type ExactValidationReceipt,
  type IndependentReviewReceipt,
  type WorkProductIdentity,
} from "../adjudication/receipts.js";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FORBIDDEN_AUTHORSHIP = /\b(?:codex|symphony|openhands|openai|agent)\b/iu;
const CONVENTIONAL_TITLE = /^(?:feat|fix|chore|docs|refactor|perf|style|test)(?:\([^)]+\))?: .+/u;

export interface ExistingPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly head: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
}

export interface PublicationPlan {
  readonly allowed: boolean;
  readonly action: "none" | "create-draft" | "update-draft";
  readonly reasons: readonly string[];
  readonly repository?: string;
  readonly title?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly body?: string;
  readonly workProduct?: WorkProductIdentity;
  readonly expectedRemoteHead?: string;
  readonly pullRequestNumber?: number;
  readonly projection?: StatusProjection;
}

export function planDraftPublication(input: {
  readonly repository: RepositoryRef;
  readonly qualification: QualificationReport;
  readonly claim: DispatchClaim;
  readonly currentClaim?: DispatchClaim;
  readonly authorityTask?: AuthorityTask;
  readonly authorityActive: boolean;
  readonly quota: QuotaDecision;
  readonly publicationCeiling: PublicationCeiling;
  readonly head: string;
  readonly workProduct: WorkProductIdentity;
  readonly validation: ExactValidationReceipt;
  readonly review: IndependentReviewReceipt;
  readonly title: string;
  readonly bodySummary: string;
  readonly existingPullRequest?: ExistingPullRequest;
  readonly now: string;
}): PublicationPlan {
  const reasons: string[] = [];
  const sameRepository =
    input.claim.repository.owner === input.repository.owner &&
    input.claim.repository.name === input.repository.name;
  if (!sameRepository || input.claim.issueNumber !== input.qualification.issue.number) {
    reasons.push("claim-identity-mismatch");
  }
  if (
    input.currentClaim === undefined ||
    input.currentClaim.claimId !== input.claim.claimId ||
    input.currentClaim.custodyEpoch !== input.claim.custodyEpoch ||
    input.currentClaim.hostId !== input.claim.hostId ||
    input.currentClaim.workerId !== input.claim.workerId
  ) {
    reasons.push("current-custody-not-proven");
  }
  if (
    !input.authorityActive ||
    input.authorityTask === undefined ||
    input.authorityTask.githubIssue.number !== input.qualification.issue.number ||
    input.authorityTask.githubIssue.url !== input.qualification.issue.url
  ) {
    reasons.push("authority-not-proven");
  }
  if (input.publicationCeiling !== "draft-pr") {
    reasons.push("publication-ceiling");
  }
  if (input.quota.action !== "admit" && input.quota.action !== "throttle") {
    reasons.push("quota-blocked");
  }
  if (!GIT_SHA_PATTERN.test(input.head)) {
    reasons.push("invalid-head");
  }
  if (
    input.workProduct.repository.owner !== input.repository.owner ||
    input.workProduct.repository.name !== input.repository.name ||
    input.workProduct.issueNumber !== input.claim.issueNumber ||
    input.workProduct.claimId !== input.claim.claimId ||
    input.workProduct.custodyEpoch !== input.claim.custodyEpoch ||
    input.workProduct.hostId !== input.claim.hostId ||
    input.workProduct.branch !== input.claim.branch ||
    input.workProduct.worktree !== input.claim.worktree
  ) {
    reasons.push("work-product-identity-mismatch");
  }
  if (input.workProduct.head !== input.head) {
    reasons.push("work-product-not-exact-head");
  }
  reasons.push(
    ...assessHandoff({
      workProduct: input.workProduct,
      validation: input.validation,
      review: input.review,
    }).reasons,
  );
  if (
    input.qualification.workLane === "provider-visible" ||
    input.qualification.workLane === "release" ||
    input.qualification.workLane === "sensitive"
  ) {
    reasons.push("unattended-lane-forbidden");
  }
  if (!CONVENTIONAL_TITLE.test(input.title) || FORBIDDEN_AUTHORSHIP.test(input.title)) {
    reasons.push("invalid-title");
  }
  if (FORBIDDEN_AUTHORSHIP.test(input.claim.branch)) {
    reasons.push("invalid-branch");
  }
  const existing = input.existingPullRequest;
  if (
    existing !== undefined &&
    (existing.state !== "open" ||
      !existing.draft ||
      existing.branch !== input.claim.branch)
  ) {
    reasons.push("existing-pull-request-conflict");
  }
  if (reasons.length > 0) {
    return { allowed: false, action: "none", reasons: [...new Set(reasons)].sort() };
  }
  const body = [
    "(AI Generated).",
    "",
    input.bodySummary,
    "",
    `Closes no issue automatically. Handoff for #${input.qualification.issue.number.toLocaleString("en-US", { useGrouping: false })}.`,
  ].join("\n");
  return {
    allowed: true,
    action: existing === undefined ? "create-draft" : "update-draft",
    reasons: [],
    repository: `${input.repository.owner}/${input.repository.name}`,
    title: input.title,
    branch: input.claim.branch,
    head: input.head,
    body,
    workProduct: input.workProduct,
    ...(existing === undefined
      ? {}
      : {
          expectedRemoteHead: existing.head,
          pullRequestNumber: existing.number,
        }),
    projection: buildStatusProjection({
      state: "human-review",
      summary: `Draft pull request prepared at exact head ${input.head}.`,
      claimId: input.claim.claimId,
      updatedAt: input.now,
    }),
  };
}
