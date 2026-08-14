import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { decideQuota } from "../../policy/quota.js";
import { assertRuntimeNeutralPilotBinding } from "../../policy/pilot-binding.js";
import {
  SymphonyAdmissionCandidateStore,
  symphonyAdmissionCandidateSchema,
  type SymphonyAdmissionCandidate,
} from "./admission-envelope.js";

const MAX_CANDIDATE_INPUT_BYTES = 1024 * 1024;

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

async function loadProtectedCandidateInput(
  inputFile: string,
): Promise<SymphonyAdmissionCandidate> {
  if (!path.isAbsolute(inputFile) || (await realpath(inputFile)) !== inputFile) {
    throw new Error("Admission candidate input must be one absolute physical file.");
  }
  const stats = await lstat(inputFile);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_CANDIDATE_INPUT_BYTES ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("Admission candidate input must be a protected physical file.");
  }
  return symphonyAdmissionCandidateSchema.parse(
    JSON.parse(await readFile(inputFile, "utf8")),
  );
}

export async function publishSymphonyAdmissionCandidateFile(input: {
  readonly inputFile: string;
  readonly candidateRoot: string;
}): Promise<{ readonly issueId: string; readonly file: string }> {
  const candidate = prepareSymphonyAdmissionCandidate(
    await loadProtectedCandidateInput(input.inputFile),
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
