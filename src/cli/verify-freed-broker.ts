#!/usr/bin/env node

import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import {
  parseFreedBrokerConformanceInput,
  runFreedBrokerConformance,
} from "../adapters/freed/broker-conformance.js";
import {
  loadProtectedJsonFile,
  writeProtectedJsonFile,
} from "../security/protected-json.js";

const inputFile = process.argv[2];
if (inputFile === undefined || !path.isAbsolute(inputFile)) {
  throw new Error("Freed broker conformance requires one absolute protected input file.");
}
const outputFile = process.env.AUBTOWN_FREED_BROKER_CONFORMANCE_FILE;
if (outputFile === undefined || !path.isAbsolute(outputFile)) {
  throw new Error("AUBTOWN_FREED_BROKER_CONFORMANCE_FILE must be absolute.");
}

const config = parseFreedBrokerConformanceInput(
  await loadProtectedJsonFile({
    file: inputFile,
    label: "Freed broker conformance input",
    maxBytes: 1024 * 1024,
  }),
);
const report = await runFreedBrokerConformance({
  runner: new ProcessCommandRunner(),
  config,
  checkedAt: new Date().toISOString(),
});
await writeProtectedJsonFile({
  file: outputFile,
  label: "Freed broker conformance report",
  value: report,
});
process.stdout.write(
  `${JSON.stringify({
    event: "freed-broker-conformance-checked",
    passed: report.passed,
    checkCount: report.checks.length,
    blockers: report.blockers,
    outputFile,
  })}\n`,
);
if (!report.passed) {
  process.exitCode = 2;
}
