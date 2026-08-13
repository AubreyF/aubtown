#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%s)-$$"
ADMITTED_KEY="dry-run-admitted-${RUN_ID}"
BLOCKED_KEY="dry-run-blocked-${RUN_ID}"
CONFLICT_KEY="dry-run-conflict-${RUN_ID}"
CUSTODY_KEY="dry-run-custody-${RUN_ID}"
TRANSFER_WORKFLOW_KEY="dry-run-transfer-${RUN_ID}"
RECONCILE_WORKFLOW_KEY="dry-run-reconcile-${RUN_ID}"
INGRESS="${FREEDWORKS_RESTATE_INGRESS:-http://127.0.0.1:8080}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl --fail --silent --show-error \
  -X POST "${INGRESS}/DryRunWorkflow/${ADMITTED_KEY}/run" \
  -H 'content-type: application/json' \
  --data-binary "@${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/admitted.json"

jq -e '
  .stage == "completed" and
  .quota.action == "admit" and
  .workerReceipt.publication == "none"
' "${TMP_DIR}/admitted.json" > /dev/null

DUPLICATE_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/duplicate.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/DryRunWorkflow/${ADMITTED_KEY}/run" \
  -H 'content-type: application/json' \
  --data-binary "@${ROOT_DIR}/test/fixtures/dry-run-admitted.json")"

if [[ "${DUPLICATE_STATUS}" != "409" ]]; then
  echo "Expected duplicate workflow start to return 409, received ${DUPLICATE_STATUS}." >&2
  exit 1
fi

curl --fail --silent --show-error \
  -X POST "${INGRESS}/DryRunWorkflow/${BLOCKED_KEY}/run" \
  -H 'content-type: application/json' \
  --data-binary "@${ROOT_DIR}/test/fixtures/dry-run-blocked-quota.json" \
  > "${TMP_DIR}/blocked.json"

jq -e '
  .stage == "blocked" and
  .quota.action == "interrupt" and
  .quota.reason == "weekly-ceiling" and
  (.workerReceipt == null)
' "${TMP_DIR}/blocked.json" > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/freed-project%2Ffreed%231234/read" \
  -H 'content-type: application/json' \
  --data '{}' \
  > "${TMP_DIR}/claim.json"

jq -e '. == null' "${TMP_DIR}/claim.json" > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/freed-project%2Ffreed/read" \
  -H 'content-type: application/json' \
  --data '{}' \
  > "${TMP_DIR}/scheduler-after-workflow.json"

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

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/${CONFLICT_KEY}/acquire" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/conflict-first.json" \
  > "${TMP_DIR}/conflict-first-result.json"

jq -e '.admitted == true' "${TMP_DIR}/conflict-first-result.json" > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/${CONFLICT_KEY}/acquire" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/conflict-second.json" \
  > "${TMP_DIR}/conflict-second-result.json"

jq -e \
  '.admitted == false and .decision.reason == "conflict-domain"' \
  "${TMP_DIR}/conflict-second-result.json" \
  > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/${CONFLICT_KEY}/release" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","custodyEpoch":1}' \
  > /dev/null

jq '.claim' "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/custody-claim.json"

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/${CUSTODY_KEY}/claim" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/custody-claim.json" \
  > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/${CUSTODY_KEY}/transfer" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","priorEpoch":1,"nextEpoch":2,"destinationHostId":"linux-control-1","destinationWorkerId":"worker-2","destinationWorktree":"/srv/freedworks/worktrees/freed/1234-epoch-2","transferredAt":"2026-08-14T08:00:00.000Z"}' \
  > "${TMP_DIR}/custody-transfer.json"

jq -e \
  '.custodyEpoch == 2 and .hostId == "linux-control-1" and .workerId == "worker-2" and .worktree == "/srv/freedworks/worktrees/freed/1234-epoch-2"' \
  "${TMP_DIR}/custody-transfer.json" \
  > /dev/null

STALE_RELEASE_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/custody-stale-release.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/ClaimRegistry/${CUSTODY_KEY}/release" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","custodyEpoch":1}')"

if [[ "${STALE_RELEASE_STATUS}" != "500" ]]; then
  echo "Expected stale custody release to return 500, received ${STALE_RELEASE_STATUS}." >&2
  exit 1
fi

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/${CUSTODY_KEY}/release" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","custodyEpoch":2}' \
  > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/freed-project%2Ffreed/acquire" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/conflict-first.json" \
  > /dev/null

jq '.claim' "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/workflow-custody-claim.json"

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/freed-project%2Ffreed%231234/claim" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/workflow-custody-claim.json" \
  > /dev/null

jq -n \
  --slurpfile fixture "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  '{
    claim: $fixture[0].claim,
    sourceHost: {
      id: "macos-executor-1",
      lane: "macos",
      online: false,
      lastHeartbeatAt: "2026-08-12T07:00:00.000Z",
      activeClaims: [$fixture[0].claim.claimId],
      accountIds: ["codex-pro-1"]
    },
    hosts: [
      {
        id: "macos-executor-1",
        lane: "macos",
        online: false,
        lastHeartbeatAt: "2026-08-12T07:00:00.000Z",
        activeClaims: [$fixture[0].claim.claimId],
        accountIds: ["codex-pro-1"]
      },
      {
        id: "linux-control-1",
        lane: "linux",
        online: true,
        lastHeartbeatAt: "2026-08-13T07:59:30.000Z",
        activeClaims: [],
        accountIds: ["codex-pro-1"]
      }
    ],
    requiredLane: "linux",
    checkpoint: {
      schemaVersion: 1,
      claimId: $fixture[0].claim.claimId,
      custodyEpoch: $fixture[0].claim.custodyEpoch,
      sourceHostId: $fixture[0].claim.hostId,
      repositoryHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      patchDigest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      includedUntrackedPaths: [],
      validationReceipts: ["focused-test:passed"],
      createdAt: "2026-08-13T07:30:00.000Z"
    },
    destinations: {
      "linux-control-1": {
        workerId: "worker-linux-1",
        worktree: "/srv/freedworks/worktrees/freed/1234-epoch-2"
      }
    },
    now: "2026-08-13T08:00:00.000Z"
  }' \
  > "${TMP_DIR}/workflow-custody-input.json"

curl --fail --silent --show-error \
  -X POST "${INGRESS}/CustodyTransferWorkflow/${TRANSFER_WORKFLOW_KEY}/run" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/workflow-custody-input.json" \
  > "${TMP_DIR}/workflow-custody-result.json"

jq -e '
  .decision.action == "transfer" and
  .decision.destinationHostId == "linux-control-1" and
  .transferredClaim.custodyEpoch == 2 and
  .transferredClaim.worktree == "/srv/freedworks/worktrees/freed/1234-epoch-2"
' "${TMP_DIR}/workflow-custody-result.json" > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ClaimRegistry/freed-project%2Ffreed%231234/release" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","custodyEpoch":2}' \
  > /dev/null

curl --fail --silent --show-error \
  -X POST "${INGRESS}/SchedulerRegistry/freed-project%2Ffreed/release" \
  -H 'content-type: application/json' \
  --data '{"claimId":"dry-run-claim-1234","custodyEpoch":2}' \
  > /dev/null

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

curl --fail --silent --show-error \
  -X POST "${INGRESS}/ReconciliationWorkflow/${RECONCILE_WORKFLOW_KEY}/run" \
  -H 'content-type: application/json' \
  --data-binary "@${TMP_DIR}/reconciliation-input.json" \
  > "${TMP_DIR}/reconciliation-result.json"

jq -e \
  '.dispatchSafe == true and .entries[0].decision.action == "continue"' \
  "${TMP_DIR}/reconciliation-result.json" \
  > /dev/null

echo "Dry-run workflow passed: duplicate rejected, quota blocked, conflict fenced, custody transferred, restart state reconciled, claims released."
