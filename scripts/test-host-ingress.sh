#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INGRESS="${FREEDWORKS_RESTATE_INGRESS:-http://127.0.0.1:8080}"
HOST_EDGE="${FREEDWORKS_HOST_EDGE:-http://127.0.0.1:8090}"
TMP_DIR="$(mktemp -d)"
RUN_ID="$(date +%s)-$$"
HOST_ID="integration-macos-${RUN_ID}"
PRIVATE_KEY="${TMP_DIR}/host-private.pem"
PUBLIC_KEY="${TMP_DIR}/host-public.pem"
trap 'rm -rf "$TMP_DIR"' EXIT

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

openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
chmod 600 "$PRIVATE_KEY"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" >/dev/null 2>&1
PUBLIC_KEY_VALUE="$(<"$PUBLIC_KEY")"
FREEDWORKS_HOST_ENROLLMENTS_JSON="$(jq -cn \
  --arg host "$HOST_ID" \
  --arg publicKeyPem "$PUBLIC_KEY_VALUE" \
  '{($host): {enabled: true, lane: "macos", accountIds: ["codex-pro-integration"], publicKeyPem: $publicKeyPem}}')"
export FREEDWORKS_HOST_ENROLLMENTS_JSON

docker compose -f "${ROOT_DIR}/deploy/compose.yaml" up -d --build --force-recreate control-plane host-edge
register_deployment
wait_for_host_edge

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

docker compose -f "${ROOT_DIR}/deploy/compose.yaml" restart restate control-plane host-edge >/dev/null
register_deployment
wait_for_host_edge

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

echo "Signed host ingress passed: narrow edge enforced, enrolled identity accepted, tampering rejected, internal objects private, replay blocked before and after restart."
