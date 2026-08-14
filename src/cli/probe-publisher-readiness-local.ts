import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { probePublisherReadiness } from "../publication/publisher-readiness.js";

if (process.argv.length !== 4) {
  throw new Error(
    "Publisher readiness requires its protected runtime config and draft publisher path.",
  );
}
const runtimeFile = process.argv[2];
const publisherFile = process.argv[3];
if (runtimeFile === undefined || publisherFile === undefined) {
  throw new Error("Publisher readiness arguments are invalid.");
}
const report = await probePublisherReadiness({
  runtimeFile,
  publisherFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
