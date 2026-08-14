import {
  assembleReconciledAdmissionCandidate,
  reconciledAdmissionCandidateInputSchema,
} from "../../orchestration/admission-candidate-reconciler.js";
import { loadProtectedJsonFile } from "../../security/protected-json.js";
import { SymphonyAdmissionCandidateStore } from "./admission-envelope.js";

export async function publishReconciledAdmissionCandidateFile(input: {
  readonly snapshotFile: string;
  readonly candidateRoot: string;
}): Promise<{ readonly issueId: string; readonly file: string }> {
  const snapshot = reconciledAdmissionCandidateInputSchema.parse(
    await loadProtectedJsonFile({
      file: input.snapshotFile,
      label: "Reconciled admission snapshot",
    }),
  );
  const candidate = assembleReconciledAdmissionCandidate(snapshot);
  const issueId = candidate.binding.qualification.issue.number.toLocaleString(
    "en-US",
    { useGrouping: false },
  );
  const file = await new SymphonyAdmissionCandidateStore(
    input.candidateRoot,
  ).publish(candidate);
  return { issueId, file };
}
