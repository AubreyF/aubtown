import { parseBindHost, parseServicePort } from "./config/network.js";
import { HostObservationJournal } from "./gateway/host-observation-journal.js";
import { createHostObservationServer } from "./gateway/host-observation-server.js";
import { loadHostEnrollments } from "./security/host-enrollment.js";

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || !value.startsWith("/")) {
    throw new Error(`${name} must be one absolute path.`);
  }
  return value;
}

const host = parseBindHost(process.env.AUBTOWN_BIND_HOST);
const port = parseServicePort(process.env.PORT, 8_090);
const enrollments = await loadHostEnrollments(process.env);
const journal = new HostObservationJournal(
  requiredAbsoluteEnvironment("AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE"),
  enrollments,
);
const server = createHostObservationServer({
  journal,
  onDenial: (reason) => {
    process.stderr.write(
      `${JSON.stringify({ event: "host-observation-denied", reason })}\n`,
    );
  },
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    process.stdout.write(
      `${JSON.stringify({ event: "host-observation-gateway-listening", host, port })}\n`,
    );
    resolve();
  });
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  process.stdout.write(
    `${JSON.stringify({ event: "host-observation-gateway-stopped", signal })}\n`,
  );
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
