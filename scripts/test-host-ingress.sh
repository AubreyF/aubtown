#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INGRESS="${FREEDWORKS_RESTATE_INGRESS:-http://127.0.0.1:8080}"
HOST_EDGE="${FREEDWORKS_HOST_EDGE:-http://127.0.0.1:8090}"
CHECKPOINT_EDGE="${FREEDWORKS_CHECKPOINT_EDGE:-http://127.0.0.1:8091}"
HARNESS="${INGRESS}/IntegrationHarness"
TMP_DIR="$(mktemp -d)"
RUN_ID="$(date +%s)-$$"
HOST_ID="integration-macos-${RUN_ID}"
LINUX_HOST_ID="integration-linux-${RUN_ID}"
PRIVATE_KEY="${TMP_DIR}/host-private.pem"
PUBLIC_KEY="${TMP_DIR}/host-public.pem"
LINUX_PRIVATE_KEY="${TMP_DIR}/linux-host-private.pem"
LINUX_PUBLIC_KEY="${TMP_DIR}/linux-host-public.pem"
GRANT_PRIVATE_KEY="${TMP_DIR}/checkpoint-grant-private.pem"
GRANT_PUBLIC_KEY="${TMP_DIR}/checkpoint-grant-public.pem"
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
  jq -n --arg key "$key" '{key: $key}' \
    | curl --fail --silent --show-error \
        -X POST "${HARNESS}/${handler}" \
        -H 'content-type: application/json' \
        --data-binary @- \
    > "$output_file"
}

harness_executor_transfer() {
  local handler="$1"
  local key="$2"
  local claim_id="$3"
  local custody_epoch="$4"
  local prepared_at="$5"
  local output_file="$6"
  jq -n \
    --arg key "$key" \
    --arg claimId "$claim_id" \
    --argjson custodyEpoch "$custody_epoch" \
    --arg preparedAt "$prepared_at" \
    '{key: $key, claimId: $claimId, custodyEpoch: $custodyEpoch, preparedAt: $preparedAt}' \
    | curl --fail --silent --show-error \
        -X POST "${HARNESS}/${handler}" \
        -H 'content-type: application/json' \
        --data-binary @- \
    > "$output_file"
}

PINNED_NODE="$(tr -d 'v[:space:]' < "${ROOT_DIR}/.nvmrc")"
ACTIVE_NODE="$(node -p 'process.versions.node')"
if [[ "$ACTIVE_NODE" != "$PINNED_NODE" ]]; then
  echo "Expected Node ${PINNED_NODE}, found ${ACTIVE_NODE}." >&2
  exit 1
fi

register_deployment() {
  for _attempt in {1..30}; do
    if docker exec deploy-restate-1 restate deployments register --force -y http://control-plane:9080 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Restate could not register the control-plane deployment." >&2
  return 1
}

wait_for_host_edge() {
  for _attempt in {1..30}; do
    if curl --silent --fail "${HOST_EDGE}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Host edge did not become healthy." >&2
  return 1
}

wait_for_checkpoint_edge() {
  for _attempt in {1..30}; do
    if curl --silent --fail "${CHECKPOINT_EDGE}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Checkpoint edge did not become healthy." >&2
  return 1
}

openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
chmod 600 "$PRIVATE_KEY"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" >/dev/null 2>&1
openssl genpkey -algorithm Ed25519 -out "$LINUX_PRIVATE_KEY" >/dev/null 2>&1
chmod 600 "$LINUX_PRIVATE_KEY"
openssl pkey -in "$LINUX_PRIVATE_KEY" -pubout -out "$LINUX_PUBLIC_KEY" >/dev/null 2>&1
openssl genpkey -algorithm Ed25519 -out "$GRANT_PRIVATE_KEY" >/dev/null 2>&1
chmod 600 "$GRANT_PRIVATE_KEY"
openssl pkey -in "$GRANT_PRIVATE_KEY" -pubout -out "$GRANT_PUBLIC_KEY" >/dev/null 2>&1
PUBLIC_KEY_VALUE="$(<"$PUBLIC_KEY")"
LINUX_PUBLIC_KEY_VALUE="$(<"$LINUX_PUBLIC_KEY")"
FREEDWORKS_HOST_ENROLLMENTS_JSON="$(jq -cn \
  --arg host "$HOST_ID" \
  --arg linuxHost "$LINUX_HOST_ID" \
  --arg publicKeyPem "$PUBLIC_KEY_VALUE" \
  --arg linuxPublicKeyPem "$LINUX_PUBLIC_KEY_VALUE" \
  '{($host): {enabled: true, lane: "macos", accountIds: ["codex-pro-integration"], publicKeyPem: $publicKeyPem}, ($linuxHost): {enabled: true, lane: "linux", accountIds: ["codex-pro-integration"], publicKeyPem: $linuxPublicKeyPem}}')"
export FREEDWORKS_HOST_ENROLLMENTS_JSON
FREEDWORKS_TEST_CHECKPOINT_GRANT_KEY_FILE="$GRANT_PRIVATE_KEY"
export FREEDWORKS_TEST_CHECKPOINT_GRANT_KEY_FILE
FREEDWORKS_TEST_CHECKPOINT_GRANT_PUBLIC_KEY_FILE="$GRANT_PUBLIC_KEY"
export FREEDWORKS_TEST_CHECKPOINT_GRANT_PUBLIC_KEY_FILE

COMPOSE_ARGS=(
  -f "${ROOT_DIR}/deploy/compose.yaml"
  -f "${ROOT_DIR}/deploy/compose.integration.yaml"
)
docker compose "${COMPOSE_ARGS[@]}" --profile checkpoint-transfer up -d --build --force-recreate control-plane host-edge checkpoint-edge
register_deployment
wait_for_host_edge
wait_for_checkpoint_edge

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq -n \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  '{schemaVersion: 1, hostId: $host, sequence: 1, issuedAt: $now, kind: "heartbeat", payload: {hostId: $host, lane: "macos", observedAt: $now, activeClaims: [], accountIds: ["codex-pro-integration"]}}' \
  > "${TMP_DIR}/heartbeat-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$PRIVATE_KEY" "${TMP_DIR}/heartbeat-unsigned.json" \
  > "${TMP_DIR}/heartbeat.json"

curl --fail --silent --show-error \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-heartbeat-1' \
  --data-binary "@${TMP_DIR}/heartbeat.json" \
  | jq -e '.kind == "heartbeat" and .sequence == 1 and .host.lane == "macos"' \
  >/dev/null

DIRECT_HOST_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/direct-host.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/HostRegistry/${HOST_ID}/read" \
  -H 'content-type: application/json' \
  --data "{\"now\":\"${NOW}\"}")"
if [[ "$DIRECT_HOST_STATUS" == "200" ]]; then
  echo "Private HostRegistry accepted a direct ingress invocation." >&2
  exit 1
fi

DIRECT_ACCOUNT_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/direct-account.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/AccountGovernor/codex-pro-integration/status" \
  -H 'content-type: application/json' \
  --data '{}')"
if [[ "$DIRECT_ACCOUNT_STATUS" == "200" ]]; then
  echo "Private AccountGovernor accepted a direct ingress invocation." >&2
  exit 1
fi

DIRECT_CLAIM_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/direct-claim.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/ClaimRegistry/probe/read" \
  -H 'content-type: application/json' \
  --data '{}')"
if [[ "$DIRECT_CLAIM_STATUS" == "200" ]]; then
  echo "Private ClaimRegistry accepted a direct ingress invocation." >&2
  exit 1
fi

DIRECT_EXECUTOR_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/direct-executor.json" \
  -w '%{http_code}' \
  -X POST "${INGRESS}/ExecutorCommandRegistry/probe/read" \
  -H 'content-type: application/json' \
  --data '{}')"
if [[ "$DIRECT_EXECUTOR_STATUS" == "200" ]]; then
  echo "Private ExecutorCommandRegistry accepted a direct ingress invocation." >&2
  exit 1
fi

EDGE_INTERNAL_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/edge-internal.json" \
  -w '%{http_code}' \
  -X POST "${HOST_EDGE}/ClaimRegistry/probe/read" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-internal-probe' \
  --data '{}')"
if [[ "$EDGE_INTERNAL_STATUS" != "404" ]]; then
  echo "Host edge exposed a route outside HostGateway, status ${EDGE_INTERNAL_STATUS}." >&2
  exit 1
fi

jq '.payload.lane = "linux"' "${TMP_DIR}/heartbeat.json" > "${TMP_DIR}/tampered-heartbeat.json"
TAMPERED_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/tampered.json" \
  -w '%{http_code}' \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-tampered-heartbeat' \
  --data-binary "@${TMP_DIR}/tampered-heartbeat.json")"
if [[ "$TAMPERED_STATUS" != "403" ]]; then
  echo "Expected tampered envelope to return 403, received ${TAMPERED_STATUS}." >&2
  exit 1
fi

jq -n \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  '{schemaVersion: 1, hostId: $host, sequence: 2, issuedAt: $now, kind: "quota-observation", payload: {observation: {accountId: "codex-pro-integration", observedAt: $now, primary: {usedPercent: 40, windowDurationMinutes: 10080, resetsAt: "2026-08-18T08:00:00.000Z"}, activeTurnIds: []}}}' \
  > "${TMP_DIR}/quota-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$PRIVATE_KEY" "${TMP_DIR}/quota-unsigned.json" \
  > "${TMP_DIR}/quota.json"
curl --fail --silent --show-error \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-quota-2' \
  --data-binary "@${TMP_DIR}/quota.json" \
  | jq -e '.kind == "quota-observation" and .sequence == 2 and .decision.action == "admit" and .decision.observedAt == .acceptedAt' \
  >/dev/null

REPLAY_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/replay.json" \
  -w '%{http_code}' \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-replay-different-key' \
  --data-binary "@${TMP_DIR}/quota.json")"
if [[ "$REPLAY_STATUS" != "409" ]]; then
  echo "Expected replay to return 409, received ${REPLAY_STATUS}." >&2
  exit 1
fi

ISSUE_NUMBER="$(date +%s)"
jq \
  --argjson issue "$ISSUE_NUMBER" \
  '.issue.number = $issue |
   .issue.url = ("https://github.com/freed-project/freed/issues/" + ($issue | tostring)) |
   .authorityTask.id = ("integration-task-" + ($issue | tostring)) |
   .authorityTask.githubIssue.number = $issue |
   .authorityTask.githubIssue.url = .issue.url |
   {repository, issue, evidence, authorityTask}' \
  "${ROOT_DIR}/test/fixtures/dry-run-admitted.json" \
  > "${TMP_DIR}/executor-qualification-input.json"
harness_file \
  runQualification \
  "integration-qualification-${ISSUE_NUMBER}" \
  input \
  "${TMP_DIR}/executor-qualification-input.json" \
  "${TMP_DIR}/executor-qualification.json"
jq -e '.eligible == true and .hostLane == "linux"' \
  "${TMP_DIR}/executor-qualification.json" \
  >/dev/null
jq -n \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  --argjson issue "$ISSUE_NUMBER" \
  --slurpfile qualification "${TMP_DIR}/executor-qualification.json" \
  '{repository: {owner: "freed-project", name: "freed", defaultBranch: "dev"}, issueNumber: $issue, claimId: ("integration-claim-" + ($issue | tostring)), custodyEpoch: 1, hostId: $host, workerId: "integration-worker", branch: ("test/checkpoint-grant-" + ($issue | tostring)), worktree: ("/tmp/freedworks-integration-" + ($issue | tostring)), conflictDomains: $qualification[0].conflictDomains, claimedAt: $now}' \
  > "${TMP_DIR}/grant-claim.json"
harness_file claim "freed-project/freed#${ISSUE_NUMBER}" claim "${TMP_DIR}/grant-claim.json" /dev/null

COMMAND_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
jq -n \
  --arg commandId "$COMMAND_ID" \
  --arg authorityTaskId "integration-task-${ISSUE_NUMBER}" \
  --arg now "$NOW" \
  --slurpfile claim "${TMP_DIR}/grant-claim.json" \
  --slurpfile qualification "${TMP_DIR}/executor-qualification.json" \
  '{commandId: $commandId, claim: $claim[0], qualification: $qualification[0], authorityTaskId: $authorityTaskId, accountId: "codex-pro-integration", issuedAt: $now}' \
  > "${TMP_DIR}/executor-command-input.json"
"${ROOT_DIR}/node_modules/.bin/tsx" \
  "${ROOT_DIR}/src/cli/build-executor-command.ts" \
  "${TMP_DIR}/executor-command-input.json" \
  > "${TMP_DIR}/executor-command.json"
harness_file \
  enqueueExecutorCommand \
  "$HOST_ID" \
  command \
  "${TMP_DIR}/executor-command.json" \
  "${TMP_DIR}/executor-command-enqueued.json"
jq -e '.stage == "pending"' "${TMP_DIR}/executor-command-enqueued.json" >/dev/null

jq -n \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  '{schemaVersion: 1, hostId: $host, sequence: 3, issuedAt: $now, kind: "executor-poll", payload: {accountId: "codex-pro-integration"}}' \
  > "${TMP_DIR}/executor-poll-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$PRIVATE_KEY" "${TMP_DIR}/executor-poll-unsigned.json" \
  > "${TMP_DIR}/executor-poll.json"
curl --fail --silent --show-error \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-executor-poll-3' \
  --data-binary "@${TMP_DIR}/executor-poll.json" \
  > "${TMP_DIR}/executor-poll-receipt.json"
jq -e \
  --arg commandId "$COMMAND_ID" \
  '.kind == "executor-poll" and .reason == "offered" and .command.commandId == $commandId' \
  "${TMP_DIR}/executor-poll-receipt.json" \
  >/dev/null

for command_stage in started completed; do
  command_sequence=4
  if [[ "$command_stage" == "completed" ]]; then
    command_sequence=5
  fi
  jq -n \
    --arg host "$HOST_ID" \
    --arg now "$NOW" \
    --arg commandId "$COMMAND_ID" \
    --arg claimId "integration-claim-${ISSUE_NUMBER}" \
    --arg stage "$command_stage" \
    --argjson sequence "$command_sequence" \
    '{schemaVersion: 1, hostId: $host, sequence: $sequence, issuedAt: $now, kind: "executor-receipt", payload: {commandId: $commandId, claimId: $claimId, custodyEpoch: 1, accountId: "codex-pro-integration", stage: $stage, threadId: "integration-thread", turnId: "integration-turn", observedAt: $now}}' \
    > "${TMP_DIR}/executor-${command_stage}-unsigned.json"
  "${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$PRIVATE_KEY" "${TMP_DIR}/executor-${command_stage}-unsigned.json" \
    > "${TMP_DIR}/executor-${command_stage}.json"
  curl --fail --silent --show-error \
    -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
    -H 'content-type: application/json' \
    -H "idempotency-key: integration-executor-${command_stage}-${command_sequence}" \
    --data-binary "@${TMP_DIR}/executor-${command_stage}.json" \
    | jq -e --arg stage "$command_stage" '.kind == "executor-receipt" and .stage == $stage' \
    >/dev/null
  if [[ "$command_stage" == "started" ]]; then
    jq -n \
      --arg key "$HOST_ID" \
      --arg claimId "integration-claim-${ISSUE_NUMBER}" \
      --arg now "$NOW" \
      '{key: $key, claimId: $claimId, custodyEpoch: 1, preparedAt: $now}' \
      > "${TMP_DIR}/active-transfer-request.json"
    ACTIVE_TRANSFER_STATUS="$(curl --silent --show-error \
      -o "${TMP_DIR}/active-transfer-response.json" \
      -w '%{http_code}' \
      -X POST "${HARNESS}/prepareExecutorTransfer" \
      -H 'content-type: application/json' \
      --data-binary "@${TMP_DIR}/active-transfer-request.json")"
    if [[ "$ACTIVE_TRANSFER_STATUS" != "500" ]]; then
      echo "Expected active executor custody transfer to return 500, received ${ACTIVE_TRANSFER_STATUS}." >&2
      exit 1
    fi
  fi
done
harness_key readExecutorCommand "$HOST_ID" "${TMP_DIR}/executor-command-finished.json"
jq -e '.stage == "completed"' "${TMP_DIR}/executor-command-finished.json" >/dev/null
PENDING_COMMAND_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
jq --arg commandId "$PENDING_COMMAND_ID" '.commandId = $commandId' \
  "${TMP_DIR}/executor-command-input.json" \
  > "${TMP_DIR}/pending-executor-command-input.json"
"${ROOT_DIR}/node_modules/.bin/tsx" \
  "${ROOT_DIR}/src/cli/build-executor-command.ts" \
  "${TMP_DIR}/pending-executor-command-input.json" \
  > "${TMP_DIR}/pending-executor-command.json"
harness_file \
  enqueueExecutorCommand \
  "$HOST_ID" \
  command \
  "${TMP_DIR}/pending-executor-command.json" \
  "${TMP_DIR}/pending-executor-command-enqueued.json"
jq -e '.stage == "pending"' "${TMP_DIR}/pending-executor-command-enqueued.json" >/dev/null
harness_executor_transfer \
  prepareExecutorTransfer \
  "$HOST_ID" \
  "integration-claim-${ISSUE_NUMBER}" \
  1 \
  "$NOW" \
  "${TMP_DIR}/executor-transfer-fence.json"
harness_key readExecutorCommand "$HOST_ID" "${TMP_DIR}/pending-executor-command-cancelled.json"
jq -e \
  --arg commandId "$PENDING_COMMAND_ID" \
  '.command.commandId == $commandId and .stage == "cancelled"' \
  "${TMP_DIR}/pending-executor-command-cancelled.json" \
  >/dev/null

jq -cn \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  --argjson issue "$ISSUE_NUMBER" \
  '{schemaVersion: 1, manifest: {schemaVersion: 2, repository: {owner: "freed-project", name: "freed", defaultBranch: "dev"}, issueNumber: $issue, claimId: ("integration-claim-" + ($issue | tostring)), custodyEpoch: 1, sourceHostId: $host, repositoryHead: ("a" * 40), baseHead: ("b" * 40), patchDigest: ("c" * 64), includedUntrackedPaths: [], validationReceipts: ["integration:passed"], createdAt: $now}, ciphertextBase64: "AQIDBA==", nonceBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", algorithm: "xchacha20-poly1305", keyReference: "keyring:integration"}' \
  > "${TMP_DIR}/checkpoint-payload.json"
CHECKPOINT_REFERENCE="$(openssl dgst -sha256 "${TMP_DIR}/checkpoint-payload.json" | awk '{print $NF}')"
CHECKPOINT_LENGTH="$(wc -c < "${TMP_DIR}/checkpoint-payload.json" | tr -d '[:space:]')"

jq -n \
  --arg host "$HOST_ID" \
  --arg now "$NOW" \
  --arg reference "$CHECKPOINT_REFERENCE" \
  --argjson issue "$ISSUE_NUMBER" \
  --argjson contentLength "$CHECKPOINT_LENGTH" \
  '{schemaVersion: 1, hostId: $host, sequence: 6, issuedAt: $now, kind: "checkpoint-grant", payload: {repository: {owner: "freed-project", name: "freed", defaultBranch: "dev"}, issueNumber: $issue, claimId: ("integration-claim-" + ($issue | tostring)), custodyEpoch: 1, checkpointEpoch: 1, operation: "upload", reference: $reference, contentLength: $contentLength}}' \
  > "${TMP_DIR}/grant-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$PRIVATE_KEY" "${TMP_DIR}/grant-unsigned.json" \
  > "${TMP_DIR}/grant-envelope.json"
curl --fail --silent --show-error \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-checkpoint-grant-6' \
  --data-binary "@${TMP_DIR}/grant-envelope.json" \
  > "${TMP_DIR}/grant-receipt.json"
jq -e \
  --arg host "$HOST_ID" \
  --arg reference "$CHECKPOINT_REFERENCE" \
  --argjson issue "$ISSUE_NUMBER" \
  --argjson contentLength "$CHECKPOINT_LENGTH" \
  '.kind == "checkpoint-grant" and .sequence == 6 and .grant.hostId == $host and .grant.issueNumber == $issue and .grant.operation == "upload" and .grant.reference == $reference and .grant.contentLength == $contentLength and (.grant.signatureBase64 | length) > 20' \
  "${TMP_DIR}/grant-receipt.json" \
  >/dev/null

jq '.grant' "${TMP_DIR}/grant-receipt.json" > "${TMP_DIR}/upload-grant.json"
UPLOAD_GRANT_NONCE="$(jq -r '.nonce' "${TMP_DIR}/upload-grant.json")"
jq -n \
  --arg host "$HOST_ID" \
  --arg nonce "$UPLOAD_GRANT_NONCE" \
  --arg now "$NOW" \
  --arg reference "$CHECKPOINT_REFERENCE" \
  '{schemaVersion: 1, hostId: $host, grantNonce: $nonce, method: "PUT", path: ("/v1/checkpoints/" + $reference), bodyDigest: $reference, requestedAt: $now}' \
  > "${TMP_DIR}/upload-proof-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-checkpoint-proof.ts" "$PRIVATE_KEY" "${TMP_DIR}/upload-proof-unsigned.json" \
  > "${TMP_DIR}/upload-proof.json"
UPLOAD_GRANT_HEADER="$(openssl base64 -A -in "${TMP_DIR}/upload-grant.json" | tr '+/' '-_' | tr -d '=')"
UPLOAD_PROOF_HEADER="$(openssl base64 -A -in "${TMP_DIR}/upload-proof.json" | tr '+/' '-_' | tr -d '=')"
curl --fail --silent --show-error \
  -X PUT "${CHECKPOINT_EDGE}/v1/checkpoints/${CHECKPOINT_REFERENCE}" \
  -H "authorization: FreedworksGrant ${UPLOAD_GRANT_HEADER}" \
  -H "x-freedworks-host-proof: ${UPLOAD_PROOF_HEADER}" \
  -H 'content-type: application/vnd.freedworks.checkpoint+json' \
  --data-binary "@${TMP_DIR}/checkpoint-payload.json" \
  | jq -e --arg reference "$CHECKPOINT_REFERENCE" '.reference == $reference' \
  >/dev/null

jq -n \
  --arg claimId "integration-claim-${ISSUE_NUMBER}" \
  --arg destinationHostId "$LINUX_HOST_ID" \
  --arg now "$NOW" \
  --arg worktree "/tmp/freedworks-linux-${ISSUE_NUMBER}" \
  '{claimId: $claimId, priorEpoch: 1, nextEpoch: 2, destinationHostId: $destinationHostId, destinationWorkerId: "integration-linux-worker", destinationWorktree: $worktree, transferredAt: $now}' \
  > "${TMP_DIR}/claim-transfer.json"
harness_file \
  transferClaim \
  "freed-project/freed#${ISSUE_NUMBER}" \
  request \
  "${TMP_DIR}/claim-transfer.json" \
  /dev/null
harness_executor_transfer \
  releaseExecutorTransfer \
  "$HOST_ID" \
  "integration-claim-${ISSUE_NUMBER}" \
  1 \
  "$NOW" \
  /dev/null

jq -n \
  --arg host "$LINUX_HOST_ID" \
  --arg now "$NOW" \
  --arg reference "$CHECKPOINT_REFERENCE" \
  --argjson issue "$ISSUE_NUMBER" \
  --argjson contentLength "$CHECKPOINT_LENGTH" \
  '{schemaVersion: 1, hostId: $host, sequence: 1, issuedAt: $now, kind: "checkpoint-grant", payload: {repository: {owner: "freed-project", name: "freed", defaultBranch: "dev"}, issueNumber: $issue, claimId: ("integration-claim-" + ($issue | tostring)), custodyEpoch: 2, checkpointEpoch: 1, operation: "download", reference: $reference, contentLength: $contentLength}}' \
  > "${TMP_DIR}/download-grant-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$LINUX_PRIVATE_KEY" "${TMP_DIR}/download-grant-unsigned.json" \
  > "${TMP_DIR}/download-grant-envelope.json"
curl --fail --silent --show-error \
  -X POST "${HOST_EDGE}/HostGateway/${LINUX_HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-checkpoint-download-grant-1' \
  --data-binary "@${TMP_DIR}/download-grant-envelope.json" \
  | jq '.grant' \
  > "${TMP_DIR}/download-grant.json"
DOWNLOAD_GRANT_NONCE="$(jq -r '.nonce' "${TMP_DIR}/download-grant.json")"
jq -n \
  --arg host "$LINUX_HOST_ID" \
  --arg nonce "$DOWNLOAD_GRANT_NONCE" \
  --arg now "$NOW" \
  --arg reference "$CHECKPOINT_REFERENCE" \
  '{schemaVersion: 1, hostId: $host, grantNonce: $nonce, method: "GET", path: ("/v1/checkpoints/" + $reference), bodyDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", requestedAt: $now}' \
  > "${TMP_DIR}/download-proof-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-checkpoint-proof.ts" "$LINUX_PRIVATE_KEY" "${TMP_DIR}/download-proof-unsigned.json" \
  > "${TMP_DIR}/download-proof.json"
DOWNLOAD_GRANT_HEADER="$(openssl base64 -A -in "${TMP_DIR}/download-grant.json" | tr '+/' '-_' | tr -d '=')"
DOWNLOAD_PROOF_HEADER="$(openssl base64 -A -in "${TMP_DIR}/download-proof.json" | tr '+/' '-_' | tr -d '=')"
curl --fail --silent --show-error \
  "${CHECKPOINT_EDGE}/v1/checkpoints/${CHECKPOINT_REFERENCE}" \
  -H "authorization: FreedworksGrant ${DOWNLOAD_GRANT_HEADER}" \
  -H "x-freedworks-host-proof: ${DOWNLOAD_PROOF_HEADER}" \
  -o "${TMP_DIR}/downloaded-checkpoint.json"
cmp "${TMP_DIR}/checkpoint-payload.json" "${TMP_DIR}/downloaded-checkpoint.json"

docker compose "${COMPOSE_ARGS[@]}" --profile checkpoint-transfer restart restate control-plane host-edge checkpoint-edge >/dev/null
register_deployment
wait_for_host_edge
wait_for_checkpoint_edge

curl --fail --silent --show-error \
  "${CHECKPOINT_EDGE}/v1/checkpoints/${CHECKPOINT_REFERENCE}" \
  -H "authorization: FreedworksGrant ${DOWNLOAD_GRANT_HEADER}" \
  -H "x-freedworks-host-proof: ${DOWNLOAD_PROOF_HEADER}" \
  -o "${TMP_DIR}/downloaded-after-restart.json"
cmp "${TMP_DIR}/checkpoint-payload.json" "${TMP_DIR}/downloaded-after-restart.json"

jq -n \
  --arg claimId "integration-claim-${ISSUE_NUMBER}" \
  '{claimId: $claimId, custodyEpoch: 2}' \
  > "${TMP_DIR}/claim-release.json"
harness_file \
  releaseClaim \
  "freed-project/freed#${ISSUE_NUMBER}" \
  expected \
  "${TMP_DIR}/claim-release.json" \
  /dev/null

jq '.sequence = 2' "${TMP_DIR}/download-grant-unsigned.json" > "${TMP_DIR}/grant-without-claim-unsigned.json"
"${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/src/cli/sign-host-envelope.ts" "$LINUX_PRIVATE_KEY" "${TMP_DIR}/grant-without-claim-unsigned.json" \
  > "${TMP_DIR}/grant-without-claim.json"
NO_CLAIM_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/grant-without-claim-response.json" \
  -w '%{http_code}' \
  -X POST "${HOST_EDGE}/HostGateway/${LINUX_HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-checkpoint-no-claim-2' \
  --data-binary "@${TMP_DIR}/grant-without-claim.json")"
if [[ "$NO_CLAIM_STATUS" != "409" ]]; then
  echo "Expected checkpoint grant without active custody to return 409, received ${NO_CLAIM_STATUS}." >&2
  exit 1
fi

REPLAY_AFTER_RESTART_STATUS="$(curl --silent --show-error \
  -o "${TMP_DIR}/replay-after-restart.json" \
  -w '%{http_code}' \
  -X POST "${HOST_EDGE}/HostGateway/${HOST_ID}/submit" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: integration-replay-after-restart' \
  --data-binary "@${TMP_DIR}/quota.json")"
if [[ "$REPLAY_AFTER_RESTART_STATUS" != "409" ]]; then
  echo "Expected replay after restart to return 409, received ${REPLAY_AFTER_RESTART_STATUS}." >&2
  exit 1
fi

echo "Signed host ingress passed: narrow edge enforced, enrolled identities accepted, tampering rejected, internal services private, claim-bound executor lifecycle completed, active transfer blocked, pending command cancelled, encrypted checkpoint moved from Mac to Linux custody, replay and restart fencing passed."
