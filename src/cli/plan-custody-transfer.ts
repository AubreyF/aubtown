#!/usr/bin/env node

import path from "node:path";
import {
  parseCustodyTransferPlanningInput,
  planCustodyTransfer,
} from "../orchestration/custody-transfer.js";
import {
  loadProtectedJsonFile,
  writeProtectedJsonFile,
} from "../security/protected-json.js";

const inputFile = process.argv[2];
if (inputFile === undefined || !path.isAbsolute(inputFile)) {
  throw new Error("Custody transfer planner requires one absolute protected input file.");
}
const outputFile = process.env.AUBTOWN_CUSTODY_TRANSFER_PLAN_FILE;
if (outputFile === undefined || !path.isAbsolute(outputFile)) {
  throw new Error("AUBTOWN_CUSTODY_TRANSFER_PLAN_FILE must be absolute.");
}
const parsed = parseCustodyTransferPlanningInput(
  await loadProtectedJsonFile({
    file: inputFile,
    label: "Custody transfer planning input",
    maxBytes: 8 * 1024 * 1024,
  }),
);
const plan = planCustodyTransfer({
  ...parsed,
  now: new Date().toISOString(),
});
await writeProtectedJsonFile({
  file: outputFile,
  label: "Custody transfer plan",
  value: plan,
});
process.stdout.write(
  `${JSON.stringify({
    event: "custody-transfer-planned",
    status: plan.status,
    action: plan.decision.action,
    outputFile,
  })}\n`,
);
if (plan.status === "blocked") {
  process.exitCode = 2;
}
