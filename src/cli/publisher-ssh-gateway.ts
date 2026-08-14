#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { runPublisherSshGateway } from "../publication/publisher-ssh-gateway.js";

if (process.argv.length !== 5) {
  throw new Error(
    "Publisher gateway requires its protected runtime, draft publisher, and authorized-keys paths.",
  );
}
const runtimeFile = process.argv[2];
const publisherFile = process.argv[3];
const authorizedKeysFile = process.argv[4];
if (
  runtimeFile === undefined ||
  publisherFile === undefined ||
  authorizedKeysFile === undefined ||
  !path.isAbsolute(runtimeFile) ||
  !path.isAbsolute(publisherFile) ||
  !path.isAbsolute(authorizedKeysFile)
) {
  throw new Error("Publisher gateway paths must be absolute.");
}
const gatewayFile = await realpath(process.argv[1]!);
const result = await runPublisherSshGateway({
  originalCommand: process.env.SSH_ORIGINAL_COMMAND,
  runtimeFile,
  publisherFile,
  gatewayFile,
  authorizedKeysFile,
  runner: new ProcessCommandRunner(),
  checkedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
