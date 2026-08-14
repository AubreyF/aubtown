import path from "node:path";
import {
  authorizeSymphonyPrelaunch,
  loadSymphonyAdmissionEnvelope,
  SymphonyPrelaunchReceiptStore,
} from "../integrations/symphony/admission-envelope.js";
import {
  denySymphonyPrelaunch,
  parseSymphonyPrelaunchRequest,
  type SymphonyPrelaunchResponse,
} from "../integrations/symphony/prelaunch.js";

const request = parseSymphonyPrelaunchRequest(process.argv.slice(2));

const envelopeRoot = process.env.AUBTOWN_PRELAUNCH_ENVELOPE_ROOT;
const receiptRoot = process.env.AUBTOWN_PRELAUNCH_RECEIPT_ROOT;

let response: SymphonyPrelaunchResponse;
if (
  envelopeRoot === undefined ||
  receiptRoot === undefined ||
  !path.isAbsolute(envelopeRoot) ||
  !path.isAbsolute(receiptRoot)
) {
  response = denySymphonyPrelaunch(
    request,
    "freed-authority-bridge-unavailable",
  );
} else {
  try {
    const envelope = await loadSymphonyAdmissionEnvelope(
      envelopeRoot,
      request.issueId,
    );
    response = await authorizeSymphonyPrelaunch({
      request,
      envelope,
      receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
      now: new Date().toISOString(),
    });
  } catch {
    response = denySymphonyPrelaunch(request, "prelaunch-state-invalid");
  }
}

process.stdout.write(`${JSON.stringify(response)}\n`);
