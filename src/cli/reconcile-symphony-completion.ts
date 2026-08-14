import path from "node:path";
import { Octokit } from "@octokit/rest";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { FreedAuthorityBridge } from "../adapters/freed/authority-bridge.js";
import { FreedClaimBrokerClient } from "../adapters/freed/claim-broker.js";
import { GitHubLivePlanningReader } from "../adapters/github/planning-source.js";
import { loadReviewedValidationProfile } from "../adjudication/validation-profile.js";
import { SshAdjudicationRunner } from "../adjudication/remote-runner.js";
import { TrustedAdjudicationResultStore } from "../adjudication/trusted-runner.js";
import { readInstallationTokenFile } from "../credentials/token-file.js";
import { SshTrustedCompletionReader } from "../execution/remote-completion-reader.js";
import { SymphonyActiveTurnJournal } from "../integrations/symphony/active-turn-journal.js";
import { loadSymphonyAdmissionEnvelope } from "../integrations/symphony/admission-envelope.js";
import {
  CompletionReconciliationStore,
  SymphonyCompletionReconciler,
} from "../orchestration/completion-reconciler.js";
import { HostObservationJournal } from "../gateway/host-observation-journal.js";
import { loadHostEnrollments } from "../security/host-enrollment.js";

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

const issueId = required("AUBTOWN_PILOT_ISSUE_NUMBER");
if (!/^[1-9][0-9]*$/u.test(issueId)) {
  throw new Error("AUBTOWN_PILOT_ISSUE_NUMBER must be one positive integer.");
}
const runner = new ProcessCommandRunner();
const envelope = await loadSymphonyAdmissionEnvelope(
  absolute("AUBTOWN_PRELAUNCH_ENVELOPE_ROOT"),
  issueId,
);
const token = await readInstallationTokenFile(absolute("GITHUB_TOKEN_FILE"));
const github = new GitHubLivePlanningReader(
  new Octokit({ auth: token }).rest,
);
const now = new Date().toISOString();
const enrollments = await loadHostEnrollments(process.env);
const observations = await new HostObservationJournal(
  absolute("AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE"),
  enrollments,
).snapshot();
const usage = observations.usageByAccountId[envelope.binding.accountId];
if (usage === undefined) {
  throw new Error("Completion reconciliation lacks current quota evidence.");
}
const current = await github.read({
  repository: envelope.binding.qualification.repository,
  issueNumber: Number(issueId),
  now,
});
const brokerExecutable = absolute("AUBTOWN_FREED_CLAIM_BROKER");
const freedRepositoryRoot = absolute("AUBTOWN_FREED_REPOSITORY_ROOT");
const reconciler = new SymphonyCompletionReconciler(
  new SshTrustedCompletionReader(runner, {
    sshExecutable: absolute("AUBTOWN_SSH_EXECUTABLE"),
    sshConfig: absolute("AUBTOWN_SYMPHONY_SSH_CONFIG"),
    commandCwd: absolute("AUBTOWN_SSH_COMMAND_CWD"),
    remoteNodeExecutable: absolute("AUBTOWN_REMOTE_NODE_EXECUTABLE"),
    remoteReaderExecutable: absolute("AUBTOWN_REMOTE_COMPLETION_READER"),
    remoteRuntimeConfig: absolute("AUBTOWN_REMOTE_WORKER_RUNTIME_CONFIG"),
    expectedUser: required("AUBTOWN_SSH_WORKER_USER"),
    expectedIdentityFile: absolute("AUBTOWN_SSH_IDENTITY_FILE"),
    expectedKnownHostsFile: absolute("AUBTOWN_SSH_KNOWN_HOSTS_FILE"),
    requiredConfigUid: 0,
  }),
  new FreedAuthorityBridge(runner, {
    repositoryRoot: freedRepositoryRoot,
    stateRoot: absolute("AUBTOWN_FREED_STATE_ROOT"),
    nodeExecutable: absolute("AUBTOWN_FREED_NODE_EXECUTABLE"),
    claimBrokerExecutable: brokerExecutable,
  }),
  new FreedClaimBrokerClient(runner, {
    executable: brokerExecutable,
    cwd: freedRepositoryRoot,
  }),
  new SymphonyActiveTurnJournal(absolute("AUBTOWN_ACTIVE_TURN_ROOT")),
);
const result = await reconciler.reconcile({
  envelope,
  currentIssue: current.issue,
  usage,
  validationProfile: await loadReviewedValidationProfile(
    absolute("AUBTOWN_VALIDATION_PROFILE_FILE"),
  ),
  now,
});
if (result === null) {
  process.stdout.write(
    `${JSON.stringify({
      event: "symphony-completion-pending",
      issueNumber: Number(issueId),
      hostId: envelope.selectedHost.id,
    })}\n`,
  );
} else {
  const published = await new CompletionReconciliationStore(
    absolute("AUBTOWN_COMPLETION_RECONCILIATION_ROOT"),
  ).publish(result);
  const adjudication = await new SshAdjudicationRunner(runner, {
    sshExecutable: absolute("AUBTOWN_SSH_EXECUTABLE"),
    sshConfig: absolute("AUBTOWN_SYMPHONY_SSH_CONFIG"),
    commandCwd: absolute("AUBTOWN_SSH_COMMAND_CWD"),
    remoteNodeExecutable: absolute("AUBTOWN_REMOTE_NODE_EXECUTABLE"),
    remoteAdjudicatorExecutable: absolute("AUBTOWN_REMOTE_ADJUDICATOR"),
    remoteWorkerRuntimeConfig: absolute("AUBTOWN_REMOTE_WORKER_RUNTIME_CONFIG"),
    remoteReviewerRuntimeConfig: absolute(
      "AUBTOWN_REMOTE_REVIEWER_RUNTIME_CONFIG",
    ),
    expectedUser: required("AUBTOWN_SSH_WORKER_USER"),
    expectedIdentityFile: absolute("AUBTOWN_SSH_IDENTITY_FILE"),
    expectedKnownHostsFile: absolute("AUBTOWN_SSH_KNOWN_HOSTS_FILE"),
    requiredConfigUid: 0,
  }).run(published.command);
  const trustedAdjudication = await new TrustedAdjudicationResultStore(
    absolute("AUBTOWN_TRUSTED_ADJUDICATION_ROOT"),
  ).record(adjudication);
  process.stdout.write(
    `${JSON.stringify({
      event: "symphony-completion-adjudicated",
      issueNumber: published.command.workProduct.issueNumber,
      hostId: published.command.workProduct.hostId,
      head: published.command.workProduct.head,
      commandId: published.command.commandId,
      completionReference: published.completionReference,
      outcome: trustedAdjudication.outcome,
    })}\n`,
  );
}
