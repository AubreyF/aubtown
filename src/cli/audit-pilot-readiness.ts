#!/usr/bin/env node

import path from "node:path";
import { auditPilotReadiness } from "../pilot/readiness.js";
import { writeProtectedJsonFile } from "../security/protected-json.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function absolute(name: string): string {
  const value = required(name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute.`);
  }
  return value;
}

function enabled(name: string): boolean {
  const value = required(name);
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false.`);
  }
  return value === "true";
}

const issueNumber = Number(required("AUBTOWN_PILOT_ISSUE_NUMBER"));
const report = await auditPilotReadiness({
  repository: required("GITHUB_REPO"),
  issueNumber,
  auditedAt: new Date().toISOString(),
  publicationEnabled: enabled("AUBTOWN_LIFECYCLE_PROJECTION_ENABLED"),
  releaseRequiredUid: 0,
  paths: {
    releaseRoot: absolute("AUBTOWN_RELEASE_ROOT"),
    symphonyLockFile: absolute("AUBTOWN_SYMPHONY_LOCK_FILE"),
    symphonyExecutable: absolute("AUBTOWN_SYMPHONY_EXECUTABLE"),
    workflowFile: absolute("AUBTOWN_SYMPHONY_WORKFLOW_FILE"),
    claimBrokerExecutable: absolute("AUBTOWN_FREED_CLAIM_BROKER"),
    brokerConformanceReportFile: absolute(
      "AUBTOWN_FREED_BROKER_CONFORMANCE_FILE",
    ),
    planningSnapshotFile: absolute("AUBTOWN_PLANNING_SNAPSHOT_FILE"),
    dispatchIntentionFile: absolute("AUBTOWN_DISPATCH_INTENTION_FILE"),
    hostEnrollmentsFile: absolute("AUBTOWN_HOST_ENROLLMENTS_FILE"),
    accountProfilesFile: absolute("AUBTOWN_ACCOUNT_PROFILES_FILE"),
    hostWorkspaceRootsFile: absolute("AUBTOWN_HOST_WORKSPACE_ROOTS_FILE"),
    executorReadinessFile: absolute("AUBTOWN_EXECUTOR_READINESS_FILE"),
    publisherReadinessFile: absolute("AUBTOWN_PUBLISHER_READINESS_FILE"),
  },
});
const outputFile = absolute("AUBTOWN_PILOT_READINESS_FILE");
await writeProtectedJsonFile({
  file: outputFile,
  label: "Pilot readiness report",
  value: report,
});
process.stdout.write(
  `${JSON.stringify({
    event: "pilot-readiness-audited",
    ready: report.ready,
    blockerCount: report.blockers.length,
    blockers: report.blockers,
    outputFile,
  })}\n`,
);
if (!report.ready) {
  process.exitCode = 2;
}
