import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { SshExecutorReadinessProbe } from "../execution/remote-executor-readiness.js";
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

const hostId = required("AUBTOWN_PILOT_EXECUTOR_HOST_ID");
const report = await new SshExecutorReadinessProbe(new ProcessCommandRunner(), {
  sshExecutable: absolute("AUBTOWN_SSH_EXECUTABLE"),
  sshConfig: absolute("AUBTOWN_SYMPHONY_SSH_CONFIG"),
  commandCwd: absolute("AUBTOWN_SSH_COMMAND_CWD"),
  remoteNodeExecutable: absolute("AUBTOWN_REMOTE_NODE_EXECUTABLE"),
  remoteProbeExecutable: absolute("AUBTOWN_REMOTE_EXECUTOR_PROBE"),
  remoteRuntimeConfig: absolute("AUBTOWN_REMOTE_WORKER_RUNTIME_CONFIG"),
  remoteWorkspacePreparer: absolute("AUBTOWN_REMOTE_WORKSPACE_PREPARER"),
}).probe(hostId);
const outputFile = absolute("AUBTOWN_EXECUTOR_READINESS_FILE");
await writeProtectedJsonFile({
  file: outputFile,
  label: "Executor readiness report",
  value: report,
});
process.stdout.write(
  `${JSON.stringify({
    event: "executor-readiness-probed",
    hostId: report.hostId,
    baseHead: report.baseHead,
    outputFile,
  })}\n`,
);
