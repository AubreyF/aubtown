import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { probeExecutorReadiness } from "../execution/executor-readiness.js";

if (process.argv.length !== 5) {
  throw new Error(
    "Executor readiness requires one runtime config, workspace preparer, and workspace completer path.",
  );
}
const runtimeFile = process.argv[2];
const preparerFile = process.argv[3];
const completionFile = process.argv[4];
if (
  runtimeFile === undefined ||
  preparerFile === undefined ||
  completionFile === undefined
) {
  throw new Error("Executor readiness arguments are invalid.");
}
const report = await probeExecutorReadiness({
  runtime: await loadWorkerRuntimeConfig(runtimeFile),
  preparerFile,
  completionFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
