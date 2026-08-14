import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { probePublisherReadiness } from "../publication/publisher-readiness.js";

if (process.argv.length !== 6) {
  throw new Error(
    "Publisher readiness requires its protected runtime, draft publisher, gateway, and authorized-keys paths.",
  );
}
const runtimeFile = process.argv[2];
const publisherFile = process.argv[3];
const gatewayFile = process.argv[4];
const authorizedKeysFile = process.argv[5];
if (
  runtimeFile === undefined ||
  publisherFile === undefined ||
  gatewayFile === undefined ||
  authorizedKeysFile === undefined
) {
  throw new Error("Publisher readiness arguments are invalid.");
}
const report = await probePublisherReadiness({
  runtimeFile,
  publisherFile,
  gatewayFile,
  authorizedKeysFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
