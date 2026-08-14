import type {
  AuthorityTask,
  IssueEvidence,
  IssueRecord,
  QualificationCheck,
  QualificationReport,
  RepositoryRef,
  WorkLane,
} from "../domain/types.js";

const SENSITIVE_LOCKS = new Set([
  "auth",
  "recovery",
  "relay",
  "release",
  "secrets",
  "signing",
  "sync",
]);

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function nonEmpty(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

function check(
  id: string,
  passed: boolean,
  blocking: boolean,
  explanation: string,
): QualificationCheck {
  return { id, passed, blocking, explanation };
}

export function deriveWorkLane(evidence: IssueEvidence): WorkLane {
  if (nonEmpty(evidence.providerNames)) {
    return "provider-visible";
  }
  if (evidence.releaseOrMigrationRisk === true) {
    return "release";
  }
  if (evidence.hostLane === "macos") {
    return "macos";
  }
  if (evidence.logicalLocks?.some((lock) => SENSITIVE_LOCKS.has(lock))) {
    return "sensitive";
  }
  if (evidence.behavioral === true) {
    return "behavioral";
  }
  if (evidence.lane !== undefined) {
    return evidence.lane;
  }
  return "runtime-neutral";
}

export function deriveConflictDomains(
  evidence: IssueEvidence,
): readonly string[] {
  const domains = new Set<string>();
  for (const ownedPath of evidence.ownedPaths ?? []) {
    const normalized = ownedPath.replace(/^\.\//, "").split("/");
    domains.add(`path:${normalized.slice(0, Math.min(2, normalized.length)).join("/")}`);
  }
  for (const lock of evidence.logicalLocks ?? []) {
    domains.add(`logical:${lock}`);
  }
  if (evidence.behavioral === true) {
    domains.add("behavior:global");
  }
  if (nonEmpty(evidence.providerNames)) {
    domains.add("provider:global");
  }
  if (evidence.hostLane === "macos") {
    domains.add("lane:macos");
  }
  return [...domains].sort();
}

export function qualifyIssue(input: {
  readonly repository: RepositoryRef;
  readonly issue: IssueRecord;
  readonly evidence: IssueEvidence;
  readonly authorityTask?: AuthorityTask;
  readonly requireExecutionAuthority?: boolean;
}): QualificationReport {
  const { repository, issue, evidence, authorityTask } = input;
  const requireAuthority = input.requireExecutionAuthority ?? true;
  const labels = new Set(issue.labels);
  const factoryLabels = issue.labels.filter((label) =>
    label.startsWith("factory:"),
  );
  const authorityMatches =
    authorityTask !== undefined &&
    authorityTask.githubIssue.number === issue.number &&
    authorityTask.githubIssue.url === issue.url &&
    authorityTask.state !== "closed";

  const checks: QualificationCheck[] = [
    check("issue-open", issue.state === "open", true, "Issue is open."),
    check("debt-label", labels.has("debt"), true, "Issue carries the debt label."),
    check(
      "factory-ready",
      labels.has("factory:ready") && factoryLabels.length === 1,
      true,
      "Owner applied factory:ready as the sole lifecycle label.",
    ),
    check(
      "incident-excluded",
      !labels.has("automation-triage"),
      true,
      "Automation incidents are excluded from the pilot.",
    ),
    check("root-cause", present(evidence.rootCause), true, "One root cause is stated."),
    check("evidence", present(evidence.evidence), true, "Current evidence is stated."),
    check("bounded-scope", present(evidence.scope), true, "Scope is bounded."),
    check(
      "acceptance-criteria",
      nonEmpty(evidence.acceptanceCriteria),
      true,
      "Acceptance criteria are explicit.",
    ),
    check(
      "validation",
      nonEmpty(evidence.validation),
      true,
      "Exact validation is explicit.",
    ),
    check(
      "conflict-domain",
      nonEmpty(evidence.ownedPaths) || nonEmpty(evidence.logicalLocks),
      true,
      "Owned paths or logical locks are declared.",
    ),
    check(
      "not-duplicate",
      evidence.duplicateOf === undefined,
      true,
      "Issue is not classified as a duplicate.",
    ),
    check(
      "provider-unattended",
      !nonEmpty(evidence.providerNames),
      true,
      "Provider-visible work cannot run unattended.",
    ),
    check(
      "owner-review-unattended",
      evidence.requiresOwnerReview !== true,
      true,
      "Owner-reviewed surfaces cannot run unattended.",
    ),
    check(
      "release-risk-unattended",
      evidence.releaseOrMigrationRisk !== true,
      true,
      "Release and migration work cannot run unattended.",
    ),
    check(
      "active-authority",
      !requireAuthority || authorityMatches,
      true,
      "An active authority task matches the exact GitHub issue.",
    ),
  ];

  const blockingFailures = checks.filter(
    (candidate) => candidate.blocking && !candidate.passed,
  ).length;
  const positiveChecks = checks.filter((candidate) => candidate.passed).length;
  const priorityScore = Math.max(
    0,
    positiveChecks * 10 - blockingFailures * 25 - (evidence.dependencies?.length ?? 0) * 3,
  );

  return {
    repository,
    issue,
    evidence,
    checks,
    eligible: blockingFailures === 0,
    priorityScore,
    conflictDomains: deriveConflictDomains(evidence),
    hostLane: evidence.hostLane ?? "linux",
    workLane: deriveWorkLane(evidence),
  };
}
