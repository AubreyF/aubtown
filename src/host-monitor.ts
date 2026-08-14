import { HostGatewayClient } from "./clients/host-gateway.js";
import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "./drivers/codex/app-server-client.js";
import { verifyCodexCompatibility } from "./drivers/codex/compatibility.js";
import { CodexQuotaSource } from "./drivers/codex/quota-source.js";
import type { HostLane } from "./domain/types.js";
import { loadHostPrivateKey } from "./security/host-enrollment.js";
import { DurableSequenceStore } from "./security/sequence-store.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const accountId = required("AUBTOWN_ACCOUNT_ID");
const hostId = required("AUBTOWN_HOST_ID");
const laneValue = required("AUBTOWN_HOST_LANE");
if (laneValue !== "linux" && laneValue !== "macos") {
  throw new Error("AUBTOWN_HOST_LANE must be linux or macos.");
}
const lane = laneValue as HostLane;
const intervalSeconds = Number(process.env.AUBTOWN_QUOTA_SAMPLE_SECONDS ?? "60");
if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 15) {
  throw new Error("AUBTOWN_QUOTA_SAMPLE_SECONDS must be at least 15 seconds.");
}
const effortValue = process.env.AUBTOWN_CODEX_EFFORT ?? "high";
if (!(["low", "medium", "high", "xhigh"] as const).some(
  (value) => value === effortValue,
)) {
  throw new Error("AUBTOWN_CODEX_EFFORT must be low, medium, high, or xhigh.");
}
const compatibility = await verifyCodexCompatibility({
  executable: required("AUBTOWN_CODEX_EXECUTABLE"),
  expectedVersion: required("AUBTOWN_CODEX_VERSION"),
});
const transport = new StdioJsonRpcTransport({ command: compatibility.executable });
const client = new CodexAppServerClient(transport);
const model = await client.assertModelCallable({
  model: required("AUBTOWN_CODEX_MODEL"),
  effort: effortValue as "low" | "medium" | "high" | "xhigh",
});
const gateway = new HostGatewayClient(
  process.env.AUBTOWN_HOST_GATEWAY_URL ?? "http://127.0.0.1:8090",
  hostId,
  await loadHostPrivateKey(required("AUBTOWN_HOST_PRIVATE_KEY_FILE")),
  new DurableSequenceStore(required("AUBTOWN_HOST_SEQUENCE_FILE")),
);
const quota = new CodexQuotaSource(client);

process.stdout.write(
  `${JSON.stringify({
    event: "host-monitor-ready",
    hostId,
    lane,
    accountId,
    codexVersion: compatibility.version,
    model: model.model,
  })}\n`,
);

let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function sample(): Promise<void> {
  const observedAt = new Date().toISOString();
  try {
    const heartbeat = await gateway.heartbeat({
      lane,
      activeClaims: [],
      accountIds: [accountId],
    });
    const observation = await quota.read(accountId, []);
    const decision = await gateway.observe({ observation, now: observedAt });
    process.stdout.write(
      `${JSON.stringify({
        event: "host-telemetry-sampled",
        hostId,
        accountId,
        heartbeatAcceptedAt: heartbeat.acceptedAt,
        decision,
      })}\n`,
    );
    if (decision.action === "interrupt") {
      process.stderr.write(
        `${JSON.stringify({
          event: "active-run-interrupt-required",
          accountId,
          reason: decision.reason,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "host-telemetry-sample-failed",
        hostId,
        accountId,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  if (!stopping) {
    timer = setTimeout(() => void sample(), intervalSeconds * 1_000);
  }
}

async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  await client.close();
  process.stdout.write(
    `${JSON.stringify({ event: "host-monitor-stopped", hostId, signal })}\n`,
  );
}

transport.onFailure((error) => {
  if (!stopping) {
    process.stderr.write(
      `${JSON.stringify({
        event: "host-monitor-app-server-failed",
        hostId,
        message: error.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
});
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
await sample();
