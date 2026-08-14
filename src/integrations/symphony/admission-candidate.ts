import { decideQuota } from "../../policy/quota.js";
import { assertRuntimeNeutralPilotBinding } from "../../policy/pilot-binding.js";
import { loadProtectedJsonFile } from "../../security/protected-json.js";
import {
  SymphonyAdmissionCandidateStore,
  symphonyAdmissionCandidateSchema,
  type SymphonyAdmissionCandidate,
} from "./admission-envelope.js";

export function prepareSymphonyAdmissionCandidate(
  input: SymphonyAdmissionCandidate,
  now = input.preparedAt,
): SymphonyAdmissionCandidate {
  const candidate = symphonyAdmissionCandidateSchema.parse(input);
  const binding = assertRuntimeNeutralPilotBinding({
    binding: candidate.binding,
    now,
  });
  if (
    candidate.selectedHost.id !== binding.claim.hostId ||
    candidate.usage.accountId !== binding.accountId ||
    (binding.qualification.hostLane === "macos" &&
      candidate.selectedHost.lane !== "macos")
  ) {
    throw new Error("Admission candidate does not match the selected route.");
  }
  const preparedAtMs = Date.parse(candidate.preparedAt);
  const observedAtMs = Date.parse(candidate.usage.observedAt);
  const baselineAtMs = Date.parse(candidate.usage.dailyBaseline.observedAt);
  if (
    preparedAtMs > Date.parse(now) ||
    observedAtMs > preparedAtMs ||
    baselineAtMs > observedAtMs ||
    candidate.usage.dailyBaseline.resetsAt !== candidate.usage.primary.resetsAt
  ) {
    throw new Error("Admission candidate quota timeline is invalid.");
  }
  const quota = decideQuota({
    snapshot: candidate.usage,
    now,
  });
  if (quota.action !== "admit" && quota.action !== "throttle") {
    throw new Error(`Admission candidate quota is blocked: ${quota.reason}.`);
  }
  return candidate;
}

export async function publishSymphonyAdmissionCandidateFile(input: {
  readonly inputFile: string;
  readonly candidateRoot: string;
}): Promise<{ readonly issueId: string; readonly file: string }> {
  const candidate = prepareSymphonyAdmissionCandidate(
    symphonyAdmissionCandidateSchema.parse(
      await loadProtectedJsonFile({
        file: input.inputFile,
        label: "Admission candidate input",
      }),
    ),
  );
  const issueId = candidate.binding.qualification.issue.number.toLocaleString(
    "en-US",
    { useGrouping: false },
  );
  const file = await new SymphonyAdmissionCandidateStore(
    input.candidateRoot,
  ).publish(candidate);
  return { issueId, file };
}
