import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { probeExecutorReadiness } from "../execution/executor-readiness.js";

if (process.argv.length !== 8) {
  throw new Error(
    "Executor readiness requires worker and reviewer runtime configs, workspace preparer, workspace completer, completion reader, and trusted adjudicator path.",
  );
}
const runtimeFile = process.argv[2];
const reviewerRuntimeFile = process.argv[3];
const preparerFile = process.argv[4];
const completionFile = process.argv[5];
const completionReaderFile = process.argv[6];
const adjudicatorFile = process.argv[7];
if (
  runtimeFile === undefined ||
  reviewerRuntimeFile === undefined ||
  preparerFile === undefined ||
  completionFile === undefined ||
  completionReaderFile === undefined ||
  adjudicatorFile === undefined
) {
  throw new Error("Executor readiness arguments are invalid.");
}
const report = await probeExecutorReadiness({
  runtime: await loadWorkerRuntimeConfig(runtimeFile),
  reviewerRuntimeFile,
  preparerFile,
  completionFile,
  completionReaderFile,
  adjudicatorFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
