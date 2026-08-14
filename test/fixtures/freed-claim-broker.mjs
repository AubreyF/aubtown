#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message, code = "broker_request_invalid") {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: 1, error: { code, message } })}\n`,
  );
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) {
    fail(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const stateFile = option("--state-file");
const profile = option("--profile");
if (!path.isAbsolute(stateFile) || !profile.startsWith("conformance-")) {
  fail("fixture broker requires an absolute state file and conformance profile");
}
const taskIndex = process.argv.indexOf("task");
const operation = process.argv[taskIndex + 1];
const requestJson = option("--request-json");
if (taskIndex < 0 || operation === undefined) {
  fail("missing task operation");
}

let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  state = { schemaVersion: 1, profile, tasks: {}, operations: {} };
}
if (state.profile !== profile) {
  fail("profile does not own this disposable state");
}

const request = JSON.parse(requestJson);

async function persist() {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function respond(action, result, operationId) {
  const response = { action, result };
  if (operationId !== undefined) {
    state.operations[operationId] = { requestJson, response };
    await persist();
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function replay() {
  if (request.operationId === undefined) return false;
  const stored = state.operations[request.operationId];
  if (stored === undefined) return false;
  if (stored.requestJson !== requestJson) {
    fail(
      "operation ID was reused with another canonical request",
      "operation_replay_conflict",
    );
  }
  process.stdout.write(`${JSON.stringify(stored.response)}\n`);
  return true;
}

if (replay()) process.exit(0);

const current = state.tasks[request.taskId];
if (operation === "claim-list") {
  const claims = Object.entries(state.tasks)
    .filter(([, task]) => task.claim != null)
    .map(([taskId, task]) => ({
      taskId,
      taskRevision: task.taskRevision,
      bindingDigest: task.bindingDigest,
      claim: task.claim,
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  await respond("task.claim-list", {
    schemaVersion: 1,
    claims,
  });
} else if (operation === "claim-acquire") {
  if (current?.claim != null) {
    fail("task already has an execution claim", "claim_already_exists");
  }
  const expiresAt = new Date(Date.parse(request.requestedAt) + 5 * 60_000).toISOString();
  const claim = {
    ...request.claim,
    heartbeatAt: request.requestedAt,
    executionStage: "claimed",
  };
  state.tasks[request.taskId] = {
    taskRevision: request.expectedTaskRevision,
    bindingDigest: request.bindingDigest,
    claim,
  };
  await respond(
    "task.claim-acquire",
    {
      schemaVersion: 1,
      operationId: request.operationId,
      taskId: request.taskId,
      taskRevision: request.expectedTaskRevision,
      authorityClaimId: request.claim.claimId,
      custodyEpoch: request.claim.custodyEpoch,
      bindingDigest: request.bindingDigest,
      conflictDomainDigest: request.claim.conflictDomainDigest,
      admission: {
        schemaVersion: 1,
        bridgeId: "freed-authority-v1",
        authorityClaimId: request.claim.claimId,
        taskId: request.taskId,
        taskRevision: request.expectedTaskRevision,
        bindingDigest: request.bindingDigest,
        authorizedAt: request.requestedAt,
        expiresAt,
      },
    },
    request.operationId,
  );
} else if (operation === "claim-show") {
  if (current === undefined) fail("unknown task");
  await respond("task.claim-show", {
    schemaVersion: 1,
    taskId: request.taskId,
    taskRevision: current.taskRevision,
    bindingDigest: current.bindingDigest,
    claim: current.claim,
  });
} else if (operation === "claim-heartbeat") {
  if (
    current?.claim == null ||
    current.taskRevision !== request.taskRevision ||
    current.bindingDigest !== request.bindingDigest ||
    current.claim.claimId !== request.authorityClaimId ||
    current.claim.custodyEpoch !== request.custodyEpoch
  ) {
    fail("heartbeat does not match the current claim epoch", "claim_epoch_mismatch");
  }
  current.claim.heartbeatAt = request.heartbeatAt;
  current.claim.executionStage = request.executionStage;
  await respond("task.claim-heartbeat", request, request.operationId);
} else if (operation === "claim-transfer") {
  if (
    current?.claim == null ||
    current.taskRevision !== request.taskRevision ||
    current.bindingDigest !== request.bindingDigest ||
    current.claim.claimId !== request.authorityClaimId ||
    current.claim.custodyEpoch !== request.priorEpoch ||
    request.nextEpoch !== request.priorEpoch + 1
  ) {
    fail("transfer does not match the current claim epoch", "claim_epoch_mismatch");
  }
  current.claim = {
    ...current.claim,
    custodyEpoch: request.nextEpoch,
    hostId: request.destinationHostId,
    workerId: request.destinationWorkerId,
    worktree: request.destinationWorktree,
    heartbeatAt: request.transferredAt,
    transferredAt: request.transferredAt,
    checkpointReference: request.checkpointReference,
  };
  await respond("task.claim-transfer", request, request.operationId);
} else if (operation === "claim-release") {
  if (
    current?.claim == null ||
    current.taskRevision !== request.expectedTaskRevision ||
    current.bindingDigest !== request.bindingDigest ||
    current.claim.claimId !== request.authorityClaimId ||
    current.claim.heartbeatAt !== request.expectedHeartbeatAt ||
    (request.custodyEpoch !== undefined &&
      current.claim.custodyEpoch !== request.custodyEpoch)
  ) {
    fail("release does not match the current claim epoch", "claim_epoch_mismatch");
  }
  current.claim = null;
  current.bindingDigest = null;
  const result = {
    schemaVersion: 1,
    operationId: request.operationId,
    taskId: request.taskId,
    taskRevision: request.expectedTaskRevision,
    authorityClaimId: request.authorityClaimId,
    bindingDigest: request.bindingDigest,
    expectedHeartbeatAt: request.expectedHeartbeatAt,
    reason: request.reason,
    releasedAt: request.releasedAt,
    ...(request.custodyEpoch === undefined
      ? {}
      : { custodyEpoch: request.custodyEpoch }),
  };
  await respond("task.claim-release", result, request.operationId);
} else {
  fail(`unsupported operation ${operation}`);
}
