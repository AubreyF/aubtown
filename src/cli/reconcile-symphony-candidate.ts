import path from "node:path";
import { publishReconciledAdmissionCandidateFile } from "../integrations/symphony/reconciled-candidate.js";

const snapshotFile = process.argv[2];
const candidateRoot = process.env.AUBTOWN_PRELAUNCH_CANDIDATE_ROOT;
if (snapshotFile === undefined || !path.isAbsolute(snapshotFile)) {
  throw new Error("Provide one absolute protected reconciler snapshot path.");
}
if (candidateRoot === undefined || !path.isAbsolute(candidateRoot)) {
  throw new Error("AUBTOWN_PRELAUNCH_CANDIDATE_ROOT must be absolute.");
}
const result = await publishReconciledAdmissionCandidateFile({
  snapshotFile,
  candidateRoot,
});
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, ...result })}\n`,
);
