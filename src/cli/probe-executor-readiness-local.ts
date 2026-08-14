import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { probeExecutorReadiness } from "../execution/executor-readiness.js";

if (process.argv.length !== 4) {
  throw new Error(
    "Executor readiness requires one runtime config and one workspace preparer path.",
  );
}
const runtimeFile = process.argv[2];
const preparerFile = process.argv[3];
if (runtimeFile === undefined || preparerFile === undefined) {
  throw new Error("Executor readiness arguments are invalid.");
}
const report = await probeExecutorReadiness({
  runtime: await loadWorkerRuntimeConfig(runtimeFile),
  preparerFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
