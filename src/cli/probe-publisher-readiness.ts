import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { SshPublisherReadinessProbe } from "../publication/remote-publisher-readiness.js";
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
const report = await new SshPublisherReadinessProbe(
  new ProcessCommandRunner(),
  {
    sshExecutable: absolute("AUBTOWN_SSH_EXECUTABLE"),
    sshConfig: absolute("AUBTOWN_SYMPHONY_SSH_CONFIG"),
    commandCwd: absolute("AUBTOWN_SSH_COMMAND_CWD"),
    expectedUser: required("AUBTOWN_SSH_PUBLISHER_USER"),
    expectedIdentityFile: absolute("AUBTOWN_SSH_PUBLISHER_IDENTITY_FILE"),
    expectedKnownHostsFile: absolute("AUBTOWN_SSH_KNOWN_HOSTS_FILE"),
    requiredConfigUid: 0,
  },
).probe(hostId);
const outputFile = absolute("AUBTOWN_PUBLISHER_READINESS_FILE");
await writeProtectedJsonFile({
  file: outputFile,
  label: "Publisher readiness report",
  value: report,
});
process.stdout.write(
  `${JSON.stringify({
    event: "publisher-readiness-probed",
    hostId: report.hostId,
    outputFile,
  })}\n`,
);
