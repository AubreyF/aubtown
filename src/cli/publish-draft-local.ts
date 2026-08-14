import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { publishDraftLocally } from "../publication/local-draft-publisher.js";

const runtimeFile = process.argv[2];
const payload = process.argv[3];
if (runtimeFile === undefined || payload === undefined) {
  throw new Error("Provide the protected publisher runtime and publication payload.");
}
const runner = new ProcessCommandRunner();
const receipt = await publishDraftLocally({ runtimeFile, payload, runner });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
