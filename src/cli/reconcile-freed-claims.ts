#!/usr/bin/env node

import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { FreedClaimBrokerClient } from "../adapters/freed/claim-broker.js";
import { reconcileStaleFreedClaims } from "../orchestration/stale-claim-reconciler.js";
import { writeProtectedJsonFile } from "../security/protected-json.js";

function absolute(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`${name} must name one absolute path.`);
  }
  return value;
}

const knownArguments = new Set(["--require-clear"]);
if (process.argv.slice(2).some((argument) => !knownArguments.has(argument))) {
  throw new Error("Stale-claim reconciliation received an unknown argument.");
}
const requireClear = process.argv.includes("--require-clear");
const broker = new FreedClaimBrokerClient(new ProcessCommandRunner(), {
  executable: absolute("AUBTOWN_FREED_CLAIM_BROKER"),
  cwd: absolute("AUBTOWN_FREED_REPOSITORY_ROOT"),
});
const result = await reconcileStaleFreedClaims({
  broker,
  now: new Date().toISOString(),
});
const outputFile = absolute("AUBTOWN_CLAIM_RECONCILIATION_FILE");
await writeProtectedJsonFile({
  file: outputFile,
  label: "Freed claim reconciliation report",
  value: result,
});
process.stdout.write(`${JSON.stringify({
  event: "freed-claims-reconciled",
  ...result,
  outputFile,
})}\n`);
if (requireClear && result.status !== "clear") {
  process.exitCode = 75;
}
