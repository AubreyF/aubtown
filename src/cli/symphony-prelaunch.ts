import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { FreedAuthorityBridge } from "../adapters/freed/authority-bridge.js";
import {
  authorizeSymphonyPrelaunch,
  loadSymphonyAdmissionCandidate,
  loadSymphonyAdmissionEnvelope,
  SymphonyAdmissionEnvelopeStore,
  SymphonyPrelaunchReceiptStore,
  type SymphonyAdmissionEnvelope,
} from "../integrations/symphony/admission-envelope.js";
import {
  SymphonyAdmissionPreparer,
  symphonyEnvelopeMatchesCandidate,
} from "../integrations/symphony/prepare-admission.js";
import {
  denySymphonyPrelaunch,
  parseSymphonyPrelaunchRequest,
  type SymphonyPrelaunchResponse,
} from "../integrations/symphony/prelaunch.js";
import { SshInitialWorkspacePreparer } from "../execution/remote-workspace-preparer.js";

const request = parseSymphonyPrelaunchRequest(process.argv.slice(2));

const envelopeRoot = process.env.AUBTOWN_PRELAUNCH_ENVELOPE_ROOT;
const receiptRoot = process.env.AUBTOWN_PRELAUNCH_RECEIPT_ROOT;
const candidateRoot = process.env.AUBTOWN_PRELAUNCH_CANDIDATE_ROOT;

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`${name} must name one absolute path.`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function optionalCurrentEnvelope(
  root: string,
  issueId: string,
): Promise<SymphonyAdmissionEnvelope | undefined> {
  try {
    return await loadSymphonyAdmissionEnvelope(root, issueId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function resolveEnvelope(now: string): Promise<SymphonyAdmissionEnvelope> {
  if (envelopeRoot === undefined) {
    throw new Error("AUBTOWN_PRELAUNCH_ENVELOPE_ROOT is missing.");
  }
  if (candidateRoot === undefined) {
    return await loadSymphonyAdmissionEnvelope(envelopeRoot, request.issueId);
  }
  const candidate = await loadSymphonyAdmissionCandidate(
    candidateRoot,
    request.issueId,
  );
  const currentEnvelope = await optionalCurrentEnvelope(
    envelopeRoot,
    request.issueId,
  );
  if (
    currentEnvelope !== undefined &&
    symphonyEnvelopeMatchesCandidate({ envelope: currentEnvelope, candidate })
  ) {
    return currentEnvelope;
  }
  const bridge = new FreedAuthorityBridge(new ProcessCommandRunner(), {
    repositoryRoot: requiredAbsoluteEnvironment(
      "AUBTOWN_FREED_REPOSITORY_ROOT",
    ),
    stateRoot: requiredAbsoluteEnvironment("AUBTOWN_FREED_STATE_ROOT"),
    nodeExecutable: requiredAbsoluteEnvironment(
      "AUBTOWN_FREED_NODE_EXECUTABLE",
    ),
    claimBrokerExecutable: requiredAbsoluteEnvironment(
      "AUBTOWN_FREED_CLAIM_BROKER",
    ),
  });
  return await new SymphonyAdmissionPreparer(
    bridge,
    new SymphonyAdmissionEnvelopeStore(envelopeRoot),
    new SshInitialWorkspacePreparer(new ProcessCommandRunner(), {
      sshExecutable: requiredAbsoluteEnvironment("AUBTOWN_SSH_EXECUTABLE"),
      sshConfig: requiredAbsoluteEnvironment("AUBTOWN_SYMPHONY_SSH_CONFIG"),
      commandCwd: requiredAbsoluteEnvironment("AUBTOWN_SSH_COMMAND_CWD"),
      remoteNodeExecutable: requiredAbsoluteEnvironment(
        "AUBTOWN_REMOTE_NODE_EXECUTABLE",
      ),
      remotePreparerExecutable: requiredAbsoluteEnvironment(
        "AUBTOWN_REMOTE_WORKSPACE_PREPARER",
      ),
      remoteRuntimeConfig: requiredAbsoluteEnvironment(
        "AUBTOWN_REMOTE_WORKER_RUNTIME_CONFIG",
      ),
      expectedUser: requiredEnvironment("AUBTOWN_SSH_WORKER_USER"),
      expectedIdentityFile: requiredAbsoluteEnvironment(
        "AUBTOWN_SSH_IDENTITY_FILE",
      ),
      expectedKnownHostsFile: requiredAbsoluteEnvironment(
        "AUBTOWN_SSH_KNOWN_HOSTS_FILE",
      ),
      requiredConfigUid: 0,
    }),
  ).resolve({
    candidate,
    now,
    ...(currentEnvelope === undefined ? {} : { currentEnvelope }),
  });
}

let response: SymphonyPrelaunchResponse;
if (
  envelopeRoot === undefined ||
  receiptRoot === undefined ||
  !path.isAbsolute(envelopeRoot) ||
  !path.isAbsolute(receiptRoot)
) {
  response = denySymphonyPrelaunch(
    request,
    "freed-authority-bridge-unavailable",
  );
} else {
  try {
    const now = new Date().toISOString();
    const envelope = await resolveEnvelope(now);
    response = await authorizeSymphonyPrelaunch({
      request,
      envelope,
      receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
      now,
    });
  } catch {
    response = denySymphonyPrelaunch(request, "prelaunch-state-invalid");
  }
}

process.stdout.write(`${JSON.stringify(response)}\n`);
