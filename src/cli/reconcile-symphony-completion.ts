import path from "node:path";
import { Octokit } from "@octokit/rest";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { FreedAuthorityBridge } from "../adapters/freed/authority-bridge.js";
import { FreedClaimBrokerClient } from "../adapters/freed/claim-broker.js";
import { GitHubLivePlanningReader } from "../adapters/github/planning-source.js";
import { loadReviewedValidationProfile } from "../adjudication/validation-profile.js";
import { SshAdjudicationRunner } from "../adjudication/remote-runner.js";
import { TrustedAdjudicationResultStore } from "../adjudication/trusted-runner.js";
import { FilePrivateKeyProvider } from "../credentials/file-private-key-provider.js";
import { GitHubAppBroker } from "../credentials/github-app-broker.js";
import { readInstallationTokenFile } from "../credentials/token-file.js";
import { SshTrustedCompletionReader } from "../execution/remote-completion-reader.js";
import {
  executorHandoffManifestDigest,
  executorHandoffManifestFromRequirement,
} from "../execution/handoff-manifest.js";
import { SymphonyActiveTurnJournal } from "../integrations/symphony/active-turn-journal.js";
import { loadSymphonyAdmissionEnvelope } from "../integrations/symphony/admission-envelope.js";
import { symphonyWorkspaceRequirementFromBinding } from "../integrations/symphony/prepare-admission.js";
import {
  CompletionReconciliationStore,
  SymphonyCompletionReconciler,
  assertIssueEligibleForCompletion,
  currentFreedClaimMatchesEnvelope,
} from "../orchestration/completion-reconciler.js";
import {
  BlockedHandoffCoordinator,
  BlockedHandoffTransactionStore,
  planBlockedHandoff,
} from "../orchestration/blocked-handoff.js";
import { DurablePublicationCoordinator } from "../orchestration/publication-coordinator.js";
import { PublicationTransactionStore } from "../orchestration/publication-transaction.js";
import { HostObservationJournal } from "../gateway/host-observation-journal.js";
import { planDraftPublication } from "../publication/policy.js";
import { SshDraftPublisher } from "../publication/remote-runner.js";
import { GitHubProjectionWriter } from "../projection/github-writer.js";
import { decideQuota } from "../policy/quota.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";
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

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function enabled(name: string): boolean {
  const value = required(name);
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false.`);
  }
  return value === "true";
}

function pullRequestTitle(issueTitle: string): string {
  const title = issueTitle.trim();
  if (/^(?:feat|fix|chore|docs|refactor|perf|style|test)(?:\([^)]+\))?: .+/u.test(title)) {
    return title;
  }
  return `fix: ${title}`;
}

function githubProjectionWriter(repository: string): GitHubProjectionWriter {
  const coordinatorIdentity = {
    appId: required("AUBTOWN_GITHUB_APP_ID"),
    installationId: positiveInteger("AUBTOWN_GITHUB_INSTALLATION_ID"),
    privateKeyReference: absolute("AUBTOWN_GITHUB_APP_PRIVATE_KEY_FILE"),
    selectedRepositories: [repository],
  };
  return new GitHubProjectionWriter(
    new GitHubAppBroker(
      coordinatorIdentity,
      undefined,
      new FilePrivateKeyProvider(),
    ),
    required("AUBTOWN_GITHUB_MACHINE_AUTHOR_LOGIN"),
  );
}

async function writeTerminalEvent(value: unknown): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  process.exit(0);
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
const completionStore = new CompletionReconciliationStore(
  absolute("AUBTOWN_COMPLETION_RECONCILIATION_ROOT"),
);
const adjudicationStore = new TrustedAdjudicationResultStore(
  absolute("AUBTOWN_TRUSTED_ADJUDICATION_ROOT"),
);
const transactionStore = new PublicationTransactionStore(
  absolute("AUBTOWN_PUBLICATION_TRANSACTION_ROOT"),
);
const blockedHandoffStore = new BlockedHandoffTransactionStore(
  absolute("AUBTOWN_PUBLICATION_TRANSACTION_ROOT"),
);
const manifestDigest = executorHandoffManifestDigest(
  executorHandoffManifestFromRequirement(
    symphonyWorkspaceRequirementFromBinding({
      binding: envelope.binding,
      requiredAt: envelope.preparedAt,
    }),
  ),
);
const priorCompletion = await completionStore.load(manifestDigest);
const priorAdjudication =
  priorCompletion === null
    ? null
    : await adjudicationStore.load(priorCompletion.command.commandId);
if (priorCompletion !== null) {
  if (priorAdjudication?.outcome === "ready") {
    let priorPublication = await transactionStore.load(
      priorAdjudication.validation.workProduct.checkpointReference,
    );
    if (
      priorPublication?.releaseCommand !== undefined &&
      priorPublication.release === undefined
    ) {
      const earlyRunner = new ProcessCommandRunner();
      const earlyClaims = new FreedClaimBrokerClient(earlyRunner, {
        executable: absolute("AUBTOWN_FREED_CLAIM_BROKER"),
        cwd: absolute("AUBTOWN_FREED_REPOSITORY_ROOT"),
      });
      const releaseReceipt = await earlyClaims.release(
        priorPublication.releaseCommand,
      );
      priorPublication = await transactionStore.recordRelease(
        priorPublication.checkpointReference,
        releaseReceipt,
      );
    }
    if (priorPublication?.stage === "released") {
      await writeTerminalEvent({
        event: "symphony-publication-already-released",
        issueNumber: priorCompletion.command.workProduct.issueNumber,
        hostId: priorCompletion.command.workProduct.hostId,
        head: priorCompletion.command.workProduct.head,
        commandId: priorCompletion.command.commandId,
        completionReference: priorCompletion.completionReference,
        outcome: priorAdjudication.outcome,
        publication: {
          stage: "released",
          pullRequestUrl: priorPublication.publication!.pullRequestUrl,
        },
      });
    }
  } else if (priorAdjudication?.outcome === "blocked") {
    let priorBlockedHandoff = await blockedHandoffStore.load(
      priorAdjudication.validation.workProduct.checkpointReference,
    );
    if (
      priorBlockedHandoff?.projection !== undefined &&
      priorBlockedHandoff.release === undefined
    ) {
      const earlyRunner = new ProcessCommandRunner();
      const earlyClaims = new FreedClaimBrokerClient(earlyRunner, {
        executable: absolute("AUBTOWN_FREED_CLAIM_BROKER"),
        cwd: absolute("AUBTOWN_FREED_REPOSITORY_ROOT"),
      });
      const releaseReceipt = await earlyClaims.release(
        priorBlockedHandoff.plan.releaseCommand,
      );
      priorBlockedHandoff = await blockedHandoffStore.recordRelease(
        priorBlockedHandoff.plan.workProduct.checkpointReference,
        releaseReceipt,
      );
    }
    if (priorBlockedHandoff?.stage === "released") {
      await writeTerminalEvent({
        event: "symphony-blocked-handoff-already-released",
        issueNumber: priorCompletion.command.workProduct.issueNumber,
        hostId: priorCompletion.command.workProduct.hostId,
        head: priorCompletion.command.workProduct.head,
        commandId: priorCompletion.command.commandId,
        completionReference: priorCompletion.completionReference,
        outcome: priorAdjudication.outcome,
        blockedHandoff: { stage: "released" },
      });
    }
  }
}
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
const authority = new FreedAuthorityBridge(runner, {
  repositoryRoot: freedRepositoryRoot,
  stateRoot: absolute("AUBTOWN_FREED_STATE_ROOT"),
  nodeExecutable: absolute("AUBTOWN_FREED_NODE_EXECUTABLE"),
  claimBrokerExecutable: brokerExecutable,
});
const claims = new FreedClaimBrokerClient(runner, {
  executable: brokerExecutable,
  cwd: freedRepositoryRoot,
});
if (priorCompletion !== null && priorAdjudication?.outcome === "blocked") {
  const priorBlockedHandoff = await blockedHandoffStore.load(
    priorAdjudication.validation.workProduct.checkpointReference,
  );
  if (priorBlockedHandoff !== null) {
    const expectedIssue = envelope.binding.qualification.issue;
    if (
      current.issue.number !== expectedIssue.number ||
      current.issue.url !== expectedIssue.url ||
      current.issue.state !== "open" ||
      (!current.issue.labels.includes("factory:ready") &&
        !current.issue.labels.includes("factory:blocked")) ||
      current.issue.labels.includes("factory:human-review")
    ) {
      throw new Error("GitHub issue changed before blocked handoff recovery.");
    }
    const [inspection, currentClaim] = await Promise.all([
      authority.inspect(envelope.binding.qualification),
      claims.show({ schemaVersion: 1, taskId: envelope.admission.taskId }),
    ]);
    const task = inspection.task;
    const expectedTask = envelope.binding.authorityTask;
    if (
      !inspection.active ||
      task === undefined ||
      task.id !== expectedTask.id ||
      task.revision !== expectedTask.revision ||
      !canonicalJsonEqual(task.githubIssue, expectedTask.githubIssue) ||
      !currentFreedClaimMatchesEnvelope(envelope, currentClaim)
    ) {
      throw new Error("Authority changed before blocked handoff recovery.");
    }
    const recovered = await new BlockedHandoffCoordinator(
      blockedHandoffStore,
      githubProjectionWriter(priorBlockedHandoff.plan.repository),
      claims,
    ).run({
      plan: priorBlockedHandoff.plan,
      projectionApproved: enabled("AUBTOWN_LIFECYCLE_PROJECTION_ENABLED"),
    });
    await writeTerminalEvent({
      event: "symphony-blocked-handoff-recovered",
      issueNumber: priorCompletion.command.workProduct.issueNumber,
      hostId: priorCompletion.command.workProduct.hostId,
      head: priorCompletion.command.workProduct.head,
      commandId: priorCompletion.command.commandId,
      completionReference: priorCompletion.completionReference,
      outcome: priorAdjudication.outcome,
      blockedHandoff: { stage: recovered.stage },
    });
  }
}
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
  authority,
  claims,
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
  let publication:
    | { readonly stage: "released"; readonly pullRequestUrl: string }
    | undefined;
  let blockedHandoff: { readonly stage: "released" } | undefined;
  if (trustedAdjudication.outcome === "ready") {
    const workProduct = trustedAdjudication.validation.workProduct;
    const review = trustedAdjudication.review;
    if (review === undefined) {
      throw new Error("Ready adjudication lacks independent review evidence.");
    }
    const transactionStore = new PublicationTransactionStore(
      absolute("AUBTOWN_PUBLICATION_TRANSACTION_ROOT"),
    );
    const existingTransaction = await transactionStore.load(
      workProduct.checkpointReference,
    );
    if (
      existingTransaction !== null &&
      !canonicalJsonEqual(existingTransaction.plan.workProduct, workProduct)
    ) {
      throw new Error("Stored publication transaction names another work product.");
    }
    const repositoryName = `${envelope.binding.qualification.repository.owner}/${envelope.binding.qualification.repository.name}`;
    const publicationCoordinator = new DurablePublicationCoordinator(
      transactionStore,
      new SshDraftPublisher(runner, {
        sshExecutable: absolute("AUBTOWN_SSH_EXECUTABLE"),
        sshConfig: absolute("AUBTOWN_SYMPHONY_SSH_CONFIG"),
        commandCwd: absolute("AUBTOWN_SSH_COMMAND_CWD"),
        remoteHostAlias: `${workProduct.hostId}-publisher`,
        expectedUser: required("AUBTOWN_SSH_PUBLISHER_USER"),
        expectedIdentityFile: absolute("AUBTOWN_SSH_PUBLISHER_IDENTITY_FILE"),
        expectedKnownHostsFile: absolute("AUBTOWN_SSH_KNOWN_HOSTS_FILE"),
        requiredConfigUid: 0,
      }),
      githubProjectionWriter(repositoryName),
      claims,
    );
    const projectionApproved = enabled(
      "AUBTOWN_LIFECYCLE_PROJECTION_ENABLED",
    );
    if (existingTransaction?.stage === "released") {
      publication = {
        stage: "released",
        pullRequestUrl: existingTransaction.publication!.pullRequestUrl,
      };
    } else if (existingTransaction?.releaseCommand !== undefined) {
      const completed = await publicationCoordinator.run({
        plan: existingTransaction.plan,
        projectionApproved,
      });
      publication = {
        stage: "released",
        pullRequestUrl: completed.publication!.pullRequestUrl,
      };
    } else {
      const publishedAt = new Date().toISOString();
      const freshObservations = await new HostObservationJournal(
        absolute("AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE"),
        enrollments,
      ).snapshot();
      const freshUsage =
        freshObservations.usageByAccountId[envelope.binding.accountId];
      if (freshUsage === undefined) {
        throw new Error("Draft publication lacks current quota evidence.");
      }
      const freshCurrent = await github.read({
        repository: envelope.binding.qualification.repository,
        issueNumber: Number(issueId),
        now: publishedAt,
      });
      if (existingTransaction?.projection === undefined) {
        assertIssueEligibleForCompletion(
          envelope.binding.qualification.issue,
          freshCurrent.issue,
        );
      } else if (
        freshCurrent.issue.number !== envelope.binding.qualification.issue.number ||
        freshCurrent.issue.url !== envelope.binding.qualification.issue.url ||
        freshCurrent.issue.state !== "open" ||
        !freshCurrent.issue.labels.includes("factory:human-review") ||
        freshCurrent.issue.labels.includes("factory:blocked")
      ) {
        throw new Error(
          "GitHub issue changed after lifecycle projection and before cleanup.",
        );
      }
      const [inspection, currentClaim] = await Promise.all([
        authority.inspect(envelope.binding.qualification),
        claims.show({ schemaVersion: 1, taskId: envelope.admission.taskId }),
      ]);
      const expectedTask = envelope.binding.authorityTask;
      const task = inspection.task;
      if (
        !inspection.active ||
        task === undefined ||
        task.id !== expectedTask.id ||
        task.revision !== expectedTask.revision ||
        !canonicalJsonEqual(task.githubIssue, expectedTask.githubIssue) ||
        task.executionAuthority !== expectedTask.executionAuthority ||
        task.providerAuthority !== expectedTask.providerAuthority ||
        task.behavioral !== expectedTask.behavioral
      ) {
        throw new Error("Freed task authority changed before draft publication.");
      }
      if (!currentFreedClaimMatchesEnvelope(envelope, currentClaim)) {
        throw new Error("Freed execution claim changed before draft publication.");
      }
      const brokerClaim = currentClaim.claim!;
      const currentDispatchClaim = {
        repository: envelope.binding.qualification.repository,
        issueNumber: brokerClaim.githubIssue.number,
        claimId: brokerClaim.claimId,
        custodyEpoch: brokerClaim.custodyEpoch,
        hostId: brokerClaim.hostId,
        workerId: brokerClaim.workerId,
        branch: brokerClaim.branch,
        worktree: brokerClaim.worktree,
        conflictDomains: brokerClaim.conflictDomains,
        claimedAt: brokerClaim.claimedAt,
      };
      const matchingPullRequests = freshCurrent.openPullRequests.filter(
        (pullRequest) => pullRequest.branch === brokerClaim.branch,
      );
      if (matchingPullRequests.length > 1) {
        throw new Error("Draft branch has multiple open pull requests.");
      }
      const plan =
        existingTransaction?.plan ??
        planDraftPublication({
          repository: envelope.binding.qualification.repository,
          qualification: envelope.binding.qualification,
          claim: envelope.binding.claim,
          currentClaim: currentDispatchClaim,
          authorityTask: task,
          authorityActive: inspection.active,
          quota: decideQuota({ snapshot: freshUsage, now: publishedAt }),
          publicationCeiling: brokerClaim.publicationCeiling,
          head: workProduct.head,
          workProduct,
          validation: trustedAdjudication.validation,
          review,
          title: pullRequestTitle(freshCurrent.issue.title),
          bodySummary: `Implements the qualified scope for GitHub issue #${freshCurrent.issue.number.toLocaleString("en-US", { useGrouping: false })}.`,
          ...(matchingPullRequests[0] === undefined
            ? {}
            : {
                existingPullRequest: {
                  number: matchingPullRequests[0].number,
                  branch: matchingPullRequests[0].branch,
                  head: matchingPullRequests[0].head,
                  draft: matchingPullRequests[0].draft,
                  state: "open" as const,
                },
              }),
          now: publishedAt,
        });
      if (!plan.allowed) {
        throw new Error(
          `Draft publication policy blocked: ${plan.reasons.join(", ")}.`,
        );
      }
      const completed = await publicationCoordinator.run({
        plan,
        projectionApproved,
        release: {
          taskId: currentClaim.taskId,
          taskRevision: currentClaim.taskRevision,
          authorityClaimId: brokerClaim.claimId,
          bindingDigest: currentClaim.bindingDigest!,
          custodyEpoch: brokerClaim.custodyEpoch,
          expectedHeartbeatAt: brokerClaim.heartbeatAt,
          releasedAt: publishedAt,
        },
      });
      publication = {
        stage: "released",
        pullRequestUrl: completed.publication!.pullRequestUrl,
      };
    }
  } else {
    const blockedAt = new Date().toISOString();
    const freshCurrent = await github.read({
      repository: envelope.binding.qualification.repository,
      issueNumber: Number(issueId),
      now: blockedAt,
    });
    assertIssueEligibleForCompletion(
      envelope.binding.qualification.issue,
      freshCurrent.issue,
    );
    const [inspection, currentClaim] = await Promise.all([
      authority.inspect(envelope.binding.qualification),
      claims.show({ schemaVersion: 1, taskId: envelope.admission.taskId }),
    ]);
    const task = inspection.task;
    const expectedTask = envelope.binding.authorityTask;
    if (
      !inspection.active ||
      task === undefined ||
      task.id !== expectedTask.id ||
      task.revision !== expectedTask.revision ||
      !canonicalJsonEqual(task.githubIssue, expectedTask.githubIssue) ||
      task.executionAuthority !== expectedTask.executionAuthority ||
      task.providerAuthority !== expectedTask.providerAuthority ||
      task.behavioral !== expectedTask.behavioral ||
      !currentFreedClaimMatchesEnvelope(envelope, currentClaim)
    ) {
      throw new Error("Authority changed before blocked handoff.");
    }
    const brokerClaim = currentClaim.claim!;
    const claim = {
      repository: envelope.binding.qualification.repository,
      issueNumber: brokerClaim.githubIssue.number,
      claimId: brokerClaim.claimId,
      custodyEpoch: brokerClaim.custodyEpoch,
      hostId: brokerClaim.hostId,
      workerId: brokerClaim.workerId,
      branch: brokerClaim.branch,
      worktree: brokerClaim.worktree,
      conflictDomains: brokerClaim.conflictDomains,
      claimedAt: brokerClaim.claimedAt,
    };
    const repositoryName = `${claim.repository.owner}/${claim.repository.name}`;
    const plan = planBlockedHandoff({
      adjudication: trustedAdjudication,
      claim,
      repository: repositoryName,
      taskId: currentClaim.taskId,
      taskRevision: currentClaim.taskRevision,
      bindingDigest: currentClaim.bindingDigest!,
      heartbeatAt: brokerClaim.heartbeatAt,
      now: blockedAt,
    });
    const completed = await new BlockedHandoffCoordinator(
      blockedHandoffStore,
      githubProjectionWriter(repositoryName),
      claims,
    ).run({
      plan,
      projectionApproved: enabled("AUBTOWN_LIFECYCLE_PROJECTION_ENABLED"),
    });
    if (completed.stage !== "released") {
      throw new Error("Blocked handoff did not finish exact claim cleanup.");
    }
    blockedHandoff = { stage: "released" };
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "symphony-completion-adjudicated",
      issueNumber: published.command.workProduct.issueNumber,
      hostId: published.command.workProduct.hostId,
      head: published.command.workProduct.head,
      commandId: published.command.commandId,
      completionReference: published.completionReference,
      outcome: trustedAdjudication.outcome,
      ...(publication === undefined ? {} : { publication }),
      ...(blockedHandoff === undefined ? {} : { blockedHandoff }),
    })}\n`,
  );
}
