import path from "node:path";
import { HostObservationJournal } from "../gateway/host-observation-journal.js";
import {
  evaluateSymphonyActiveRunGuard,
  interruptSymphonyActiveRun,
  parseSymphonyActiveRunGuardRequest,
  type SymphonyActiveRunGuardResponse,
} from "../integrations/symphony/active-run-guard.js";
import { loadSymphonyAdmissionEnvelope } from "../integrations/symphony/admission-envelope.js";
import { loadHostEnrollments } from "../security/host-enrollment.js";

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`${name} must name one absolute path.`);
  }
  return value;
}

const request = parseSymphonyActiveRunGuardRequest(process.argv.slice(2));
let response: SymphonyActiveRunGuardResponse;

try {
  const enrollments = await loadHostEnrollments(process.env);
  const envelope = await loadSymphonyAdmissionEnvelope(
    requiredAbsoluteEnvironment("AUBTOWN_PRELAUNCH_ENVELOPE_ROOT"),
    request.issueId,
  );
  const observations = await new HostObservationJournal(
    requiredAbsoluteEnvironment("AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE"),
    enrollments,
  ).snapshot();
  response = evaluateSymphonyActiveRunGuard({
    request,
    envelope,
    observations,
    enrollments,
    now: new Date().toISOString(),
  });
} catch {
  response = interruptSymphonyActiveRun(request, "active-guard-state-invalid");
}

process.stdout.write(`${JSON.stringify(response)}\n`);
