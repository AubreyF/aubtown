import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { completeTrustedSymphonyWorkspace } from "../execution/trusted-completion.js";

const configFile = process.argv[2];
if (configFile === undefined) {
  throw new Error("Provide the absolute worker runtime config path.");
}
const receipt = await completeTrustedSymphonyWorkspace({
  workspace: process.cwd(),
  runtime: await loadWorkerRuntimeConfig(configFile),
  runner: new ProcessCommandRunner(),
  completedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
