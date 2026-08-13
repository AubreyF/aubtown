import type {
  AuthorityTask,
  IssueEvidence,
  IssueRecord,
  QualificationReport,
  RepositoryRef,
} from "../domain/types.js";
import { qualifyIssue } from "../policy/admission.js";

export interface QualificationCandidate {
  readonly issue: IssueRecord;
  readonly evidence: IssueEvidence;
  readonly authorityTask?: AuthorityTask;
}

export function qualifyIssues(input: {
  readonly repository: RepositoryRef;
  readonly candidates: readonly QualificationCandidate[];
  readonly requireExecutionAuthority?: boolean;
}): readonly QualificationReport[] {
  return input.candidates
    .map((candidate) =>
      qualifyIssue({
        repository: input.repository,
        issue: candidate.issue,
        evidence: candidate.evidence,
        ...(candidate.authorityTask === undefined
          ? {}
          : { authorityTask: candidate.authorityTask }),
        ...(input.requireExecutionAuthority === undefined
          ? {}
          : { requireExecutionAuthority: input.requireExecutionAuthority }),
      }),
    )
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        Date.parse(right.issue.updatedAt) - Date.parse(left.issue.updatedAt) ||
        left.issue.number - right.issue.number,
    );
}
