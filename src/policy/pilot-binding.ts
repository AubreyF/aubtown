import type { ExecutionAdmissionBinding } from "../adapters/execution-admission.js";
import { executionAdmissionBindingSchema } from "../adapters/execution-admission.js";
import { canonicalJson } from "../security/canonical-json.js";

const CLAIM_MAX_AGE_SECONDS = 120;

export type RuntimeNeutralPilotBindingDecision =
  | "eligible"
  | "time-invalid"
  | "issue-ineligible"
  | "authority-ineligible"
  | "binding-mismatch"
  | "conflict-mismatch";

function normalizedConflictDomains(
  domains: readonly string[],
): readonly string[] {
  return [...new Set(domains)].sort((left, right) => left.localeCompare(right));
}

function exactDomains(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return Buffer.from(canonicalJson(left)).equals(canonicalJson(right));
}

export function evaluateRuntimeNeutralPilotBinding(input: {
  readonly binding: ExecutionAdmissionBinding;
  readonly now: string;
}): RuntimeNeutralPilotBindingDecision {
  const binding = executionAdmissionBindingSchema.parse(input.binding);
  const qualification = binding.qualification;
  const issue = qualification.issue;
  const task = binding.authorityTask;
  const claim = binding.claim;
  const nowMs = Date.parse(input.now);
  const claimedAtMs = Date.parse(claim.claimedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(claimedAtMs) ||
    claimedAtMs > nowMs ||
    nowMs - claimedAtMs > CLAIM_MAX_AGE_SECONDS * 1_000
  ) {
    return "time-invalid";
  }

  const factoryLabels = issue.labels.filter((label) =>
    label.startsWith("factory:"),
  );
  if (
    issue.state !== "open" ||
    !issue.labels.includes("debt") ||
    issue.labels.includes("automation-triage") ||
    factoryLabels.length !== 1 ||
    factoryLabels[0] !== "factory:ready" ||
    !qualification.eligible ||
    qualification.checks.some((check) => check.blocking && !check.passed) ||
    qualification.workLane !== "runtime-neutral" ||
    qualification.evidence.behavioral !== false ||
    qualification.evidence.requiresOwnerReview === true ||
    qualification.evidence.releaseOrMigrationRisk === true ||
    (qualification.evidence.providerNames?.length ?? 0) > 0
  ) {
    return "issue-ineligible";
  }

  if (
    task.behavioral ||
    task.state !== "approved_for_pr" ||
    !["pr-only", "merge-safe"].includes(task.executionAuthority) ||
    task.providerAuthority !== "forbidden"
  ) {
    return "authority-ineligible";
  }

  const qualificationRepository = qualification.repository;
  if (
    task.githubIssue.number !== issue.number ||
    task.githubIssue.url !== issue.url ||
    claim.issueNumber !== issue.number ||
    claim.repository.owner !== qualificationRepository.owner ||
    claim.repository.name !== qualificationRepository.name ||
    claim.repository.defaultBranch !== qualificationRepository.defaultBranch
  ) {
    return "binding-mismatch";
  }

  const qualificationDomains = normalizedConflictDomains(
    qualification.conflictDomains,
  );
  const claimDomains = normalizedConflictDomains(claim.conflictDomains);
  if (
    claimDomains.length === 0 ||
    !exactDomains(qualificationDomains, claimDomains)
  ) {
    return "conflict-mismatch";
  }
  return "eligible";
}

export function assertRuntimeNeutralPilotBinding(input: {
  readonly binding: ExecutionAdmissionBinding;
  readonly now: string;
}): ExecutionAdmissionBinding {
  const binding = executionAdmissionBindingSchema.parse(input.binding);
  const decision = evaluateRuntimeNeutralPilotBinding({
    binding,
    now: input.now,
  });
  if (decision !== "eligible") {
    throw new Error(
      `Dispatch is outside the runtime-neutral pilot policy: ${decision}.`,
    );
  }
  return binding;
}
