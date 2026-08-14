import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { assertPreparedSymphonyWorkspace } from "../integrations/symphony/workspace-guard.js";

const configFile = process.argv[2];
if (configFile === undefined) {
  throw new Error("Provide the absolute worker runtime config path.");
}
const result = await assertPreparedSymphonyWorkspace({
  workspace: process.cwd(),
  config: await loadWorkerRuntimeConfig(configFile),
  runner: new ProcessCommandRunner(),
});
process.stdout.write(`${JSON.stringify({ status: "prepared", ...result })}\n`);
