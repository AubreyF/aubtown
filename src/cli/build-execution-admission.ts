import { readFile } from "node:fs/promises";
import {
  assertExecutionAdmission,
  createExecutionAdmissionDigest,
  type ExecutionAdmission,
  type ExecutionAdmissionBinding,
} from "../adapters/execution-admission.js";

interface AdmissionInput {
  readonly binding: ExecutionAdmissionBinding;
  readonly admission: Omit<ExecutionAdmission, "bindingDigest">;
}

const inputFile = process.argv[2];
if (inputFile === undefined || !inputFile.startsWith("/")) {
  throw new Error("Provide one absolute execution admission input path.");
}
const input = JSON.parse(await readFile(inputFile, "utf8")) as AdmissionInput;
const admission: ExecutionAdmission = {
  ...input.admission,
  bindingDigest: createExecutionAdmissionDigest(input.binding),
};
assertExecutionAdmission({
  admission,
  binding: input.binding,
  now: admission.authorizedAt,
});
process.stdout.write(`${JSON.stringify(admission)}\n`);
