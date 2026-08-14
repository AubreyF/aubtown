#!/usr/bin/env node

import path from "node:path";
import { Octokit } from "@octokit/rest";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { FreedAuthorityBridge } from "../adapters/freed/authority-bridge.js";
import { FreedClaimBrokerClient } from "../adapters/freed/claim-broker.js";
import { GitHubLivePlanningReader } from "../adapters/github/planning-source.js";
import { loadExecutionAccountProfiles } from "../config/account-profiles.js";
import { loadHostWorkspaceRoots } from "../config/host-workspaces.js";
import { readInstallationTokenFile } from "../credentials/token-file.js";
import type { RepositoryRef } from "../domain/types.js";
import { HostObservationJournal } from "../gateway/host-observation-journal.js";
import {
  FreedBrokerPlanningAuthorityReader,
  GitLocalRepositoryPlanningReader,
  LivePlanningSnapshotCollector,
} from "../orchestration/live-planning-snapshot.js";
import { buildStableDispatchIntention } from "../orchestration/dispatch-intention.js";
import { loadHostEnrollments } from "../security/host-enrollment.js";
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

function issueNumber(): number {
  const value = Number(required("AUBTOWN_PILOT_ISSUE_NUMBER"));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("AUBTOWN_PILOT_ISSUE_NUMBER must be a positive safe integer.");
  }
  return value;
}

function repository(): RepositoryRef {
  const value = required("GITHUB_REPO");
  const [owner, name, extra] = value.split("/");
  if (owner === undefined || name === undefined || extra !== undefined) {
    throw new Error("GITHUB_REPO must have owner/name form.");
  }
  return {
    owner,
    name,
    defaultBranch: process.env.AUBTOWN_REPOSITORY_DEFAULT_BRANCH?.trim() || "dev",
  };
}

const token = await readInstallationTokenFile(absolute("GITHUB_TOKEN_FILE"));
const enrollments = await loadHostEnrollments(process.env);
const runner = new ProcessCommandRunner();
const freedRoot = absolute("AUBTOWN_FREED_REPOSITORY_ROOT");
const authorityBridge = new FreedAuthorityBridge(runner, {
  repositoryRoot: freedRoot,
  stateRoot: absolute("AUBTOWN_FREED_STATE_ROOT"),
  nodeExecutable: absolute("AUBTOWN_FREED_NODE_EXECUTABLE"),
});
const authorityBroker = new FreedClaimBrokerClient(runner, {
  executable: absolute("AUBTOWN_FREED_CLAIM_BROKER"),
  cwd: freedRoot,
});
const collector = new LivePlanningSnapshotCollector(
  new GitHubLivePlanningReader(new Octokit({ auth: token }).rest),
  new FreedBrokerPlanningAuthorityReader(authorityBridge, authorityBroker),
  new HostObservationJournal(
    absolute("AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE"),
    enrollments,
  ),
  new GitLocalRepositoryPlanningReader(
    runner,
    absolute("AUBTOWN_GIT_EXECUTABLE"),
  ),
);
const report = await collector.collect({
  repository: repository(),
  issueNumber: issueNumber(),
  repositoryRoot: freedRoot,
  now: new Date().toISOString(),
});
const dispatch = buildStableDispatchIntention({
  snapshot: report,
  accountProfiles: await loadExecutionAccountProfiles(process.env, enrollments),
  hostWorkspaceRoots: await loadHostWorkspaceRoots(
    absolute("AUBTOWN_HOST_WORKSPACE_ROOTS_FILE"),
    enrollments,
  ),
});
const outputFile = absolute("AUBTOWN_PLANNING_SNAPSHOT_FILE");
await writeProtectedJsonFile({
  file: outputFile,
  label: "Live planning snapshot",
  value: report,
});
const dispatchFile = absolute("AUBTOWN_DISPATCH_INTENTION_FILE");
await writeProtectedJsonFile({
  file: dispatchFile,
  label: "Stable dispatch intention",
  value: dispatch,
});
process.stdout.write(
  `${JSON.stringify({
    event: "planning-snapshot-collected",
    issueNumber: report.issueNumber,
    planningSafe: report.planningSafe,
    blockerCount: report.blockers.length,
    outputFile,
    dispatchStatus: dispatch.status,
    dispatchFile,
  })}\n`,
);
