import path from "node:path";
import { publishSymphonyAdmissionCandidateFile } from "../integrations/symphony/admission-candidate.js";

const inputFile = process.argv[2];
const candidateRoot = process.env.AUBTOWN_PRELAUNCH_CANDIDATE_ROOT;
if (inputFile === undefined || !path.isAbsolute(inputFile)) {
  throw new Error("Provide one absolute protected admission candidate input path.");
}
if (candidateRoot === undefined || !path.isAbsolute(candidateRoot)) {
  throw new Error("AUBTOWN_PRELAUNCH_CANDIDATE_ROOT must be absolute.");
}
const result = await publishSymphonyAdmissionCandidateFile({
  inputFile,
  candidateRoot,
});
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, ...result })}\n`,
);
