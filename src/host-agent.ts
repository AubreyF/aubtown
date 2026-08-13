import { CodexAppServerClient, StdioJsonRpcTransport } from "./drivers/codex/app-server-client.js";
import { CodexDriver } from "./drivers/codex/driver.js";
import { CodexQuotaSource } from "./drivers/codex/quota-source.js";
import { RestateUsageGovernorClient } from "./clients/restate-governor.js";
import { QuotaMonitor } from "./supervision/quota-monitor.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const accountId = requiredEnvironment("FREEDWORKS_ACCOUNT_ID");
const ingress = process.env.FREEDWORKS_RESTATE_INGRESS ?? "http://127.0.0.1:8080";
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

const transport = new StdioJsonRpcTransport();
const client = new CodexAppServerClient(transport);
const usage = new CodexQuotaSource(client);
const worker = new CodexDriver(client, {
  model,
  effort,
});
const governor = new RestateUsageGovernorClient(ingress, accountId);
const monitor = new QuotaMonitor(usage, worker, governor);

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
    const receipt = await monitor.sample(accountId);
    process.stdout.write(`${JSON.stringify({ event: "quota-sampled", ...receipt })}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "quota-sample-failed",
        message: error instanceof Error ? error.message : String(error),
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
