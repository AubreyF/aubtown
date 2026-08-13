#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%s)-$$"
SOURCE_HOST_ID="dry-run-linux-source-${RUN_ID}"
DESTINATION_HOST_ID="dry-run-linux-destination-${RUN_ID}"
ADMITTED_KEY="dry-run-admitted-${RUN_ID}"
BLOCKED_KEY="dry-run-blocked-${RUN_ID}"
CONFLICT_KEY="dry-run-conflict-${RUN_ID}"
CUSTODY_KEY="dry-run-custody-${RUN_ID}"
TRANSFER_WORKFLOW_KEY="dry-run-transfer-${RUN_ID}"
MISSING_RECEIPT_WORKFLOW_KEY="dry-run-transfer-missing-receipt-${RUN_ID}"
LANE_MISMATCH_WORKFLOW_KEY="dry-run-transfer-lane-mismatch-${RUN_ID}"
RECONCILE_WORKFLOW_KEY="dry-run-reconcile-${RUN_ID}"
INGRESS="${FREEDWORKS_RESTATE_INGRESS:-http://127.0.0.1:8080}"
HARNESS="${INGRESS}/IntegrationHarness"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

harness_file() {
  local handler="$1"
  local key="$2"
  local field="$3"
  local input_file="$4"
  local output_file="$5"
  local request_file
  request_file="$(mktemp "${TMP_DIR}/harness-request.XXXXXX")"
  jq -n \
    --arg key "$key" \
    --arg field "$field" \
    --slurpfile value "$input_file" \
    '{key: $key} + {($field): $value[0]}' \
    > "$request_file"
  curl --fail --silent --show-error \
    -X POST "${HARNESS}/${handler}" \
    -H 'content-type: application/json' \
    --data-binary "@${request_file}" \
    > "$output_file"
  rm -f "$request_file"
}

harness_key() {
  local handler="$1"
  local key="$2"
  local output_file="$3"
  curl --fail --silent --show-error \
    -X POST "${HARNESS}/${handler}" \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg key "$key" '{key: $key}')" \
    > "$output_file"
}

harness_file \
  runDryRun \
  "$ADMITTED_KEY" \
  input \
  "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  "${TMP_DIR}/admitted.json"

jq -e '
  .stage == "completed" and
  .quota.action == "admit" and
  .workerReceipt.publication == "none"
' "${TMP_DIR}/admitted.json" > /dev/null

jq -n \
  --arg key "$ADMITTED_KEY" \
  --slurpfile input "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  '{key: $key, input: $input[0]}' \
  > "${TMP_DIR}/duplicate-input.json"
DUPLICATE_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/duplicate.json" \
  -w '%{http_code}' \
  -X POST "${HARNESS}/runDryRun" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/duplicate-input.json")"

if [[ "${DUPLICATE_STATUS}" != "409" ]]; then
  echo "Expected duplicate workflow start to return 409, received ${DUPLICATE_STATUS}." >&2
  exit 1
fi

harness_file \
  runDryRun \
  "$BLOCKED_KEY" \
  input \
  "${ROOT_DIR}/test/fixtures/dry-run-blocked-quota.json" \
  "${TMP_DIR}/blocked.json"

jq -e '
  .stage == "blocked" and
  .quota.action == "interrupt" and
  .quota.reason == "weekly-ceiling" and
  (.workerReceipt == null)
' "${TMP_DIR}/blocked.json" > /dev/null

harness_key readClaim "freed-project/freed#1234" "${TMP_DIR}/claim.json"

jq -e '. == null' "${TMP_DIR}/claim.json" > /dev/null

harness_key readScheduler "freed-project/freed" "${TMP_DIR}/scheduler-after-workflow.json"

jq -e '. == []' "${TMP_DIR}/scheduler-after-workflow.json" > /dev/null

jq -n \
  --slurpfile fixture "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  --slurpfile result "${TMP_DIR}/admitted.json" \
  '{claim: $fixture[0].claim, qualification: $result[0].qualification, concurrency: "bounded"}' \
  > "${TMP_DIR}/conflict-first.json"

jq \
  '.claim.issueNumber = 1235 |
   .claim.claimId = "claim-conflict-second" |
   .claim.branch = "fix/conflict-second" |
   .claim.worktree = "/srv/freedworks/worktrees/freed/1235" |
   .qualification.issue.number = 1235 |
   .qualification.issue.url = "https://github.com/freed-project/freed/issues/1235" |
   .qualification.issue.title = "Second conflicting issue"' \
  "${TMP_DIR}/conflict-first.json" \
  > "${TMP_DIR}/conflict-second.json"

harness_file \
  acquireScheduler \
  "$CONFLICT_KEY" \
  input \
  "${TMP_DIR}/conflict-first.json" \
  "${TMP_DIR}/conflict-first-result.json"

jq -e '.admitted == true' "${TMP_DIR}/conflict-first-result.json" > /dev/null

harness_file \
  acquireScheduler \
  "$CONFLICT_KEY" \
  input \
  "${TMP_DIR}/conflict-second.json" \
  "${TMP_DIR}/conflict-second-result.json"

jq -e \
  '.admitted == false and .decision.reason == "conflict-domain"' \
  "${TMP_DIR}/conflict-second-result.json" \
  > /dev/null

jq -n '{claimId: "dry-run-claim-1234", custodyEpoch: 1}' \
  > "${TMP_DIR}/release-epoch-1.json"
harness_file \
  releaseScheduler \
  "$CONFLICT_KEY" \
  expected \
  "${TMP_DIR}/release-epoch-1.json" \
  /dev/null

jq '.claim' "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/custody-claim.json"

harness_file claim "$CUSTODY_KEY" claim "${TMP_DIR}/custody-claim.json" /dev/null

jq -n '{claimId: "dry-run-claim-1234", priorEpoch: 1, nextEpoch: 2, destinationHostId: "linux-control-1", destinationWorkerId: "worker-2", destinationWorktree: "/srv/freedworks/worktrees/freed/1234-epoch-2", transferredAt: "2026-08-14T08:00:00.000Z"}' \
  > "${TMP_DIR}/custody-transfer-input.json"
harness_file \
  transferClaim \
  "$CUSTODY_KEY" \
  request \
  "${TMP_DIR}/custody-transfer-input.json" \
  "${TMP_DIR}/custody-transfer.json"

jq -e \
  '.custodyEpoch == 2 and .hostId == "linux-control-1" and .workerId == "worker-2" and .worktree == "/srv/freedworks/worktrees/freed/1234-epoch-2"' \
  "${TMP_DIR}/custody-transfer.json" \
  > /dev/null

jq -n \
  --arg key "$CUSTODY_KEY" \
  '{key: $key, expected: {claimId: "dry-run-claim-1234", custodyEpoch: 1}}' \
  > "${TMP_DIR}/custody-stale-release-input.json"
STALE_RELEASE_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/custody-stale-release.json" \
  -w '%{http_code}' \
  -X POST "${HARNESS}/releaseClaim" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/custody-stale-release-input.json")"

if [[ "${STALE_RELEASE_STATUS}" != "500" ]]; then
  echo "Expected stale custody release to return 500, received ${STALE_RELEASE_STATUS}." >&2
  exit 1
fi

jq -n '{claimId: "dry-run-claim-1234", custodyEpoch: 2}' \
  > "${TMP_DIR}/release-epoch-2.json"
harness_file \
  releaseClaim \
  "$CUSTODY_KEY" \
  expected \
  "${TMP_DIR}/release-epoch-2.json" \
  /dev/null

jq \
  --arg host "$SOURCE_HOST_ID" \
  '.claim | .hostId = $host | .workerId = "offline-worker" | .worktree = "/srv/freedworks/worktrees/freed/1234-offline"' \
  "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/workflow-custody-claim.json"

jq -n \
  --slurpfile claim "${TMP_DIR}/workflow-custody-claim.json" \
  --slurpfile admitted "${TMP_DIR}/admitted.json" \
  '{claim: $claim[0], qualification: $admitted[0].qualification, concurrency: "bounded"}' \
  > "${TMP_DIR}/workflow-scheduler-input.json"
harness_file \
  acquireScheduler \
  "freed-project/freed" \
  input \
  "${TMP_DIR}/workflow-scheduler-input.json" \
  /dev/null

harness_file \
  claim \
  "freed-project/freed#1234" \
  claim \
  "${TMP_DIR}/workflow-custody-claim.json" \
  /dev/null

jq -n \
  --arg host "$SOURCE_HOST_ID" \
  '{hostId: $host, lane: "linux", observedAt: "2026-08-12T07:00:00.000Z", activeClaims: ["dry-run-claim-1234"], accountIds: ["codex-pro-1"]}' \
  > "${TMP_DIR}/workflow-source-heartbeat.json"
harness_file \
  heartbeatHost \
  "$SOURCE_HOST_ID" \
  heartbeat \
  "${TMP_DIR}/workflow-source-heartbeat.json" \
  /dev/null

jq -n \
  --arg host "$DESTINATION_HOST_ID" \
  '{hostId: $host, lane: "linux", observedAt: "2026-08-13T07:59:30.000Z", activeClaims: [], accountIds: ["codex-pro-1"]}' \
  > "${TMP_DIR}/workflow-destination-heartbeat.json"
harness_file \
  heartbeatHost \
  "$DESTINATION_HOST_ID" \
  heartbeat \
  "${TMP_DIR}/workflow-destination-heartbeat.json" \
  /dev/null

OFFLINE_COMMAND_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"
jq -n \
  --arg commandId "$OFFLINE_COMMAND_ID" \
  --slurpfile claim "${TMP_DIR}/workflow-custody-claim.json" \
  --slurpfile fixture "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  --slurpfile admitted "${TMP_DIR}/admitted.json" \
  '{commandId: $commandId, claim: $claim[0], qualification: $admitted[0].qualification, authorityTaskId: $fixture[0].authorityTask.id, accountId: "codex-pro-1", issuedAt: "2026-08-13T07:55:00.000Z"}' \
  > "${TMP_DIR}/workflow-offline-command-input.json"
"${ROOT_DIR}/node_modules/.bin/tsx" \
  "${ROOT_DIR}/src/cli/build-executor-command.ts" \
  "${TMP_DIR}/workflow-offline-command-input.json" \
  > "${TMP_DIR}/workflow-offline-command.json"
harness_file \
  enqueueExecutorCommand \
  "$SOURCE_HOST_ID" \
  command \
  "${TMP_DIR}/workflow-offline-command.json" \
  /dev/null
jq -n \
  --arg key "$SOURCE_HOST_ID" \
  --arg commandId "$OFFLINE_COMMAND_ID" \
  '{key: $key, commandId: $commandId, offeredAt: "2026-08-13T07:56:00.000Z"}' \
  | curl --fail --silent --show-error \
      -X POST "${HARNESS}/offerExecutorCommand" \
      -H 'content-type: application/json' \
      --data-binary @- \
      >/dev/null
jq -n \
  --arg key "$SOURCE_HOST_ID" \
  --arg commandId "$OFFLINE_COMMAND_ID" \
  '{key: $key, acceptedAt: "2026-08-13T07:57:00.000Z", receipt: {commandId: $commandId, claimId: "dry-run-claim-1234", custodyEpoch: 1, accountId: "codex-pro-1", stage: "started", threadId: "offline-thread", turnId: "offline-turn", observedAt: "2026-08-13T07:57:00.000Z"}}' \
  | curl --fail --silent --show-error \
      -X POST "${HARNESS}/recordExecutorCommand" \
      -H 'content-type: application/json' \
      --data-binary @- \
      >/dev/null

jq -n \
  --arg source "$SOURCE_HOST_ID" \
  --slurpfile claim "${TMP_DIR}/workflow-custody-claim.json" \
  '{schemaVersion: 1, reference: ("d" * 64), contentLength: 1024, hostId: $source, grantNonce: "33333333-3333-4333-8333-333333333333", manifest: {schemaVersion: 2, repository: $claim[0].repository, issueNumber: $claim[0].issueNumber, claimId: $claim[0].claimId, custodyEpoch: $claim[0].custodyEpoch, sourceHostId: $claim[0].hostId, repositoryHead: ("a" * 40), baseHead: ("b" * 40), patchDigest: ("c" * 64), includedUntrackedPaths: [], validationReceipts: ["focused-test:passed"], createdAt: "2026-08-13T07:30:00.000Z"}, storedAt: "2026-08-13T07:30:01.000Z", signatureBase64: "integration-harness-only"}' \
  > "${TMP_DIR}/workflow-checkpoint-receipt.json"

jq -n \
  --arg source "$SOURCE_HOST_ID" \
  --arg destination "$DESTINATION_HOST_ID" \
  --slurpfile claim "${TMP_DIR}/workflow-custody-claim.json" \
  '{
    claim: $claim[0],
    sourceHost: {
      id: $source,
      lane: "linux",
      online: false,
      lastHeartbeatAt: "2026-08-12T07:00:00.000Z",
      activeClaims: [$claim[0].claimId],
      accountIds: ["codex-pro-1"]
    },
    hosts: [
      {
        id: $source,
        lane: "linux",
        online: false,
        lastHeartbeatAt: "2026-08-12T07:00:00.000Z",
        activeClaims: [$claim[0].claimId],
        accountIds: ["codex-pro-1"]
      },
      {
        id: $destination,
        lane: "linux",
        online: true,
        lastHeartbeatAt: "2026-08-13T07:59:30.000Z",
        activeClaims: [],
        accountIds: ["codex-pro-1"]
      }
    ],
    requiredLane: "linux",
    checkpointReference: ("d" * 64),
    destinations: {
      ($destination): {
        workerId: "worker-linux-1",
        worktree: "/srv/freedworks/worktrees/freed/1234-epoch-2"
      }
    },
    now: "2026-08-13T08:00:00.000Z"
  }' \
  > "${TMP_DIR}/workflow-custody-input.json"

jq -n \
  --arg key "$MISSING_RECEIPT_WORKFLOW_KEY" \
  --slurpfile input "${TMP_DIR}/workflow-custody-input.json" \
  '{key: $key, input: $input[0]}' \
  > "${TMP_DIR}/workflow-custody-missing-receipt-request.json"
MISSING_RECEIPT_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/workflow-custody-missing-receipt-response.json" \
  -w '%{http_code}' \
  -X POST "${HARNESS}/runCustodyTransfer" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/workflow-custody-missing-receipt-request.json")"
if [[ "$MISSING_RECEIPT_STATUS" != "500" ]]; then
  echo "Expected unregistered custody checkpoint to return 500, received ${MISSING_RECEIPT_STATUS}." >&2
  exit 1
fi

harness_file \
  recordCheckpointReceipt \
  "$(printf 'd%.0s' {1..64})" \
  receipt \
  "${TMP_DIR}/workflow-checkpoint-receipt.json" \
  /dev/null

jq '.requiredLane = "macos"' \
  "${TMP_DIR}/workflow-custody-input.json" \
  > "${TMP_DIR}/workflow-custody-lane-mismatch-input.json"
jq -n \
  --arg key "$LANE_MISMATCH_WORKFLOW_KEY" \
  --slurpfile input "${TMP_DIR}/workflow-custody-lane-mismatch-input.json" \
  '{key: $key, input: $input[0]}' \
  > "${TMP_DIR}/workflow-custody-lane-mismatch-request.json"
LANE_MISMATCH_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/workflow-custody-lane-mismatch-response.json" \
  -w '%{http_code}' \
  -X POST "${HARNESS}/runCustodyTransfer" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/workflow-custody-lane-mismatch-request.json")"
if [[ "$LANE_MISMATCH_STATUS" != "500" ]]; then
  echo "Expected changed custody host lane to return 500, received ${LANE_MISMATCH_STATUS}." >&2
  exit 1
fi

harness_file \
  runCustodyTransfer \
  "$TRANSFER_WORKFLOW_KEY" \
  input \
  "${TMP_DIR}/workflow-custody-input.json" \
  "${TMP_DIR}/workflow-custody-result.json"

jq -e \
  --arg destination "$DESTINATION_HOST_ID" \
  '
  .decision.action == "transfer" and
  .decision.destinationHostId == $destination and
  .transferredClaim.custodyEpoch == 2 and
  .transferredClaim.worktree == "/srv/freedworks/worktrees/freed/1234-epoch-2"
' "${TMP_DIR}/workflow-custody-result.json" > /dev/null

harness_key readExecutorCommand "$SOURCE_HOST_ID" "${TMP_DIR}/workflow-offline-command-superseded.json"
jq -e \
  --arg commandId "$OFFLINE_COMMAND_ID" \
  '.command.commandId == $commandId and .stage == "superseded"' \
  "${TMP_DIR}/workflow-offline-command-superseded.json" \
  >/dev/null

harness_file \
  releaseClaim \
  "freed-project/freed#1234" \
  expected \
  "${TMP_DIR}/release-epoch-2.json" \
  /dev/null

harness_file \
  releaseScheduler \
  "freed-project/freed" \
  expected \
  "${TMP_DIR}/release-epoch-2.json" \
  /dev/null

jq -n \
  --slurpfile fixture "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  '{
    observedAt: "2026-08-13T08:00:00.000Z",
    now: "2026-08-13T08:00:30.000Z",
    maxAgeSeconds: 120,
    claims: [$fixture[0].claim],
    issues: [{
      number: $fixture[0].issue.number,
      url: $fixture[0].issue.url,
      open: true,
      labels: ["debt", "factory:running"],
      openPullRequestBranches: [$fixture[0].claim.branch]
    }],
    authorityTasks: [$fixture[0].authorityTask],
    workspaces: [{
      hostId: $fixture[0].claim.hostId,
      claimId: $fixture[0].claim.claimId,
      custodyEpoch: $fixture[0].claim.custodyEpoch,
      branch: $fixture[0].claim.branch,
      worktree: $fixture[0].claim.worktree,
      exists: true
    }]
  }' \
  > "${TMP_DIR}/reconciliation-input.json"

harness_file \
  runReconciliation \
  "$RECONCILE_WORKFLOW_KEY" \
  input \
  "${TMP_DIR}/reconciliation-input.json" \
  "${TMP_DIR}/reconciliation-result.json"

jq -e \
  '.dispatchSafe == true and .entries[0].decision.action == "continue"' \
  "${TMP_DIR}/reconciliation-result.json" \
  > /dev/null

echo "Dry-run workflow passed: duplicate rejected, quota blocked, conflict fenced, unauthenticated checkpoint rejected, canonical 24-hour failover superseded the offline turn, custody transferred, restart state reconciled, claims released."
