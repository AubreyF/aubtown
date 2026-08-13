import { CodexAppServerClient, StdioJsonRpcTransport } from "./drivers/codex/app-server-client.js";
import { CodexDriver } from "./drivers/codex/driver.js";
import { CodexQuotaSource } from "./drivers/codex/quota-source.js";
import { HostGatewayClient } from "./clients/host-gateway.js";
import { QuotaMonitor } from "./supervision/quota-monitor.js";
import { loadHostPrivateKey } from "./security/host-enrollment.js";
import { DurableSequenceStore } from "./security/sequence-store.js";
import type { HostLane } from "./domain/types.js";
import { verifyCodexCompatibility } from "./drivers/codex/compatibility.js";
import { HostExecutionJournal } from "./execution/journal.js";
import { HostExecutionSupervisor } from "./execution/supervisor.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const accountId = requiredEnvironment("FREEDWORKS_ACCOUNT_ID");
const hostId = requiredEnvironment("FREEDWORKS_HOST_ID");
const hostLaneValue = requiredEnvironment("FREEDWORKS_HOST_LANE");
if (hostLaneValue !== "linux" && hostLaneValue !== "macos") {
  throw new Error("FREEDWORKS_HOST_LANE must be linux or macos.");
}
const hostLane = hostLaneValue as HostLane;
const privateKey = await loadHostPrivateKey(
  requiredEnvironment("FREEDWORKS_HOST_PRIVATE_KEY_FILE"),
);
const sequenceStore = new DurableSequenceStore(
  requiredEnvironment("FREEDWORKS_HOST_SEQUENCE_FILE"),
);
const gatewayUrl = process.env.FREEDWORKS_HOST_GATEWAY_URL ?? "http://127.0.0.1:8090";
const intervalSeconds = Number(process.env.FREEDWORKS_QUOTA_SAMPLE_SECONDS ?? "60");
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 15) {
  throw new Error("FREEDWORKS_QUOTA_SAMPLE_SECONDS must be an integer of at least 15.");
}
const model = requiredEnvironment("FREEDWORKS_CODEX_MODEL");
const effortValue = process.env.FREEDWORKS_CODEX_EFFORT ?? "high";
if (!["low", "medium", "high", "xhigh"].includes(effortValue)) {
  throw new Error("FREEDWORKS_CODEX_EFFORT must be low, medium, high, or xhigh.");
}
const effort = effortValue as "low" | "medium" | "high" | "xhigh";
const codexCompatibility = await verifyCodexCompatibility({
  executable: requiredEnvironment("FREEDWORKS_CODEX_EXECUTABLE"),
  expectedVersion: requiredEnvironment("FREEDWORKS_CODEX_VERSION"),
});

const transport = new StdioJsonRpcTransport({ command: codexCompatibility.executable });
const client = new CodexAppServerClient(transport);
const advertisedModel = await client.assertModelCallable({ model, effort });
process.stdout.write(
  `${JSON.stringify({
    event: "codex-compatibility-verified",
    ...codexCompatibility,
    model: advertisedModel.model,
    effort,
  })}\n`,
);
const usage = new CodexQuotaSource(client);
const worker = new CodexDriver(client, {
  model,
  effort,
});
const governor = new HostGatewayClient(
  gatewayUrl,
  hostId,
  privateKey,
  sequenceStore,
);
const monitor = new QuotaMonitor(usage, worker, governor);
const executionJournal = new HostExecutionJournal(
  requiredEnvironment("FREEDWORKS_EXECUTION_JOURNAL_FILE"),
);
const execution = new HostExecutionSupervisor(
  accountId,
  worker,
  executionJournal,
  governor,
  monitor,
  (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
);
await execution.recover();

let stopped = false;
let timer: NodeJS.Timeout | undefined;

async function stop(signal: string): Promise<void> {
  if (stopped) {
    return;
  }
  stopped = true;
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  await client.close();
  process.stdout.write(`${JSON.stringify({ event: "host-agent-stopped", signal })}\n`);
}

async function sample(): Promise<void> {
  try {
    await execution.flush();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "executor-receipt-flush-failed",
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  try {
    const heartbeat = await governor.heartbeat({
      lane: hostLane,
      activeClaims: await execution.activeClaimIds(),
      accountIds: [accountId],
    });
    process.stdout.write(`${JSON.stringify({ event: "host-heartbeat", ...heartbeat })}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "host-heartbeat-failed",
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  try {
    const receipt = await monitor.sample(accountId);
    process.stdout.write(`${JSON.stringify({ event: "quota-sampled", ...receipt })}\n`);
    if (
      receipt.decision.action === "admit" ||
      receipt.decision.action === "throttle"
    ) {
      const poll = await governor.pollExecutor(accountId);
      process.stdout.write(
        `${JSON.stringify({
          event: "executor-polled",
          reason: poll.reason,
          commandId: poll.command?.commandId,
        })}\n`,
      );
      if (poll.command !== null) {
        await execution.accept(poll.command);
      }
    }
  } catch (error) {
    const interruptedTurnIds = await monitor.enforceTelemetryFreshness(accountId, 120);
    process.stderr.write(
      `${JSON.stringify({
        event: "quota-sample-failed",
        message: error instanceof Error ? error.message : String(error),
        interruptedTurnIds,
      })}\n`,
    );
  }
  if (!stopped) {
    timer = setTimeout(() => void sample(), intervalSeconds * 1_000);
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
await sample();
