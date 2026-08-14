import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseExecutionAccountProfiles } from "../config/account-profiles.js";
import { loadHostWorkspaceRoots } from "../config/host-workspaces.js";
import { buildStableDispatchIntention } from "../orchestration/dispatch-intention.js";
import type { LivePlanningSnapshot } from "../orchestration/live-planning-snapshot.js";
import { canonicalJson } from "../security/canonical-json.js";
import { parseHostEnrollments } from "../security/host-enrollment.js";
import { loadProtectedJsonFile } from "../security/protected-json.js";
import {
  selectedExecutorReadinessReportSchema,
  type SelectedExecutorReadinessReport,
} from "../execution/executor-readiness.js";
import {
  selectedPublisherReadinessReportSchema,
  type SelectedPublisherReadinessReport,
} from "../publication/publisher-readiness.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface PilotReadinessCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface PilotReadinessReport {
  readonly schemaVersion: 1;
  readonly auditedAt: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly ready: boolean;
  readonly checks: readonly PilotReadinessCheck[];
  readonly blockers: readonly string[];
}

export interface PilotReadinessPaths {
  readonly releaseRoot: string;
  readonly symphonyLockFile: string;
  readonly symphonyExecutable: string;
  readonly workflowFile: string;
  readonly claimBrokerExecutable: string;
  readonly brokerConformanceReportFile: string;
  readonly planningSnapshotFile: string;
  readonly dispatchIntentionFile: string;
  readonly hostEnrollmentsFile: string;
  readonly accountProfilesFile: string;
  readonly hostWorkspaceRootsFile: string;
  readonly executorReadinessFile: string;
  readonly publisherReadinessFile: string;
}

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

const planningSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  planningSafe: z.boolean(),
  blockers: z.array(z.string().min(1)),
});

const dispatchSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("blocked"),
    blockers: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    status: z.literal("ready"),
    intention: z.object({
      schemaVersion: z.literal(1),
      intentionId: z.string().regex(/^dispatch-[0-9a-f]{64}$/u),
      sourceDigest: z.string().regex(digestPattern),
      plannedAt: z.iso.datetime(),
      candidateInput: z.object({
        qualification: z.object({
          repository: repositorySchema,
          issue: z.object({ number: z.number().int().positive(), url: z.url() }),
          eligible: z.literal(true),
        }),
        authorityTask: z.object({
          githubIssue: z.object({ number: z.number().int().positive(), url: z.url() }),
        }),
        intendedClaim: z.object({
          repository: repositorySchema,
          issueNumber: z.number().int().positive(),
          claimId: z.string().min(1),
          hostId: z.string().min(1),
          worktree: z.string().min(1),
          branch: z.string().min(1),
        }),
        baseHead: z.string().regex(commitPattern),
        now: z.iso.datetime(),
      }),
    }),
  }),
]);

const lockSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal("https://github.com/openai/symphony.git"),
  production: z.object({
    commit: z.string().regex(commitPattern),
    sourceSha256: z.string().regex(digestPattern),
  }),
  patches: z.array(
    z.object({
      path: z.string().regex(/^upstream\/patches\/[A-Za-z0-9._-]+\.patch$/u),
      sha256: z.string().regex(digestPattern),
      verifiedAgainst: z.string().regex(commitPattern),
    }),
  ).min(1),
  reviewedCapabilities: z.array(z.string().min(1)),
  knownGaps: z.array(z.string().min(1)),
});

const brokerConformanceSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.string().regex(/^conformance-[a-z0-9][a-z0-9-]{2,63}$/u),
  brokerExecutable: z.string().min(1),
  brokerSha256: z.string().regex(digestPattern),
  checkedAt: z.iso.datetime(),
  passed: z.literal(true),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      passed: z.literal(true),
      detail: z.string().min(1),
    }),
  ).min(13),
  blockers: z.array(z.never()).length(0),
});

function repositoryName(value: z.infer<typeof repositorySchema>): string {
  return `${value.owner}/${value.name}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function physicalFile(input: {
  readonly file: string;
  readonly label: string;
  readonly executable: boolean;
  readonly maxBytes: number;
}): Promise<string> {
  if (!path.isAbsolute(input.file) || (await realpath(input.file)) !== input.file) {
    throw new Error(`${input.label} is not one absolute physical file.`);
  }
  const stats = await lstat(input.file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > input.maxBytes ||
    (stats.mode & 0o022) !== 0 ||
    (input.executable && (stats.mode & 0o111) === 0)
  ) {
    throw new Error(`${input.label} has unsafe type, mode, size, or executability.`);
  }
  return input.file;
}

function check(
  id: string,
  operation: () => string | Promise<string>,
): Promise<PilotReadinessCheck> {
  return Promise.resolve()
    .then(operation)
    .then(
      (evidence) => ({ id, passed: true, evidence }),
      (error: unknown) => ({
        id,
        passed: false,
        evidence: error instanceof Error ? error.message : String(error),
      }),
    );
}

function assertFresh(timestamp: string, now: string, maxAgeSeconds: number): void {
  const ageSeconds = (Date.parse(now) - Date.parse(timestamp)) / 1_000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > maxAgeSeconds
  ) {
    throw new Error(`Evidence is outside the ${maxAgeSeconds.toLocaleString()} second freshness window.`);
  }
}

export async function auditPilotReadiness(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly auditedAt: string;
  readonly publicationEnabled: boolean;
  readonly paths: PilotReadinessPaths;
}): Promise<PilotReadinessReport> {
  if (
    !repositoryPattern.test(input.repository) ||
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber < 1 ||
    !Number.isFinite(Date.parse(input.auditedAt))
  ) {
    throw new Error("Pilot readiness identity or audit timestamp is invalid.");
  }
  for (const [name, value] of Object.entries(input.paths)) {
    if (!path.isAbsolute(value)) {
      throw new Error(`Pilot readiness path ${name} must be absolute.`);
    }
  }

  let lock: z.infer<typeof lockSchema> | undefined;
  let planning: z.infer<typeof planningSchema> | undefined;
  let dispatch: z.infer<typeof dispatchSchema> | undefined;
  let executorReadiness: SelectedExecutorReadinessReport | undefined;
  let publisherReadiness: SelectedPublisherReadinessReport | undefined;
  let workspacePreparerSha256: string | undefined;
  let workspaceCompleterSha256: string | undefined;
  let workspaceCompletionReaderSha256: string | undefined;
  let workspaceAdjudicatorSha256: string | undefined;
  let draftPublisherSha256: string | undefined;
  let publisherGatewaySha256: string | undefined;
  let expectedNodeVersion: string | undefined;
  let planningSource: unknown;
  let dispatchSource: unknown;

  const checks = await Promise.all([
    check("runtime:symphony-lock", async () => {
      await physicalFile({
        file: input.paths.symphonyLockFile,
        label: "Symphony lock",
        executable: false,
        maxBytes: 1024 * 1024,
      });
      lock = lockSchema.parse(
        JSON.parse(await readFile(input.paths.symphonyLockFile, "utf8")),
      );
      return `production:${lock.production.commit}`;
    }),
    check("runtime:workflow", async () => {
      await physicalFile({
        file: input.paths.workflowFile,
        label: "Symphony workflow",
        executable: false,
        maxBytes: 1024 * 1024,
      });
      const workflow = await readFile(input.paths.workflowFile, "utf8");
      for (const required of [
        "kind: github",
        "factory:ready",
        "symphony-prelaunch.js",
        "symphony-active-run-guard.js",
        "complete-symphony-workspace.js",
        "max_concurrent_agents: 1",
      ]) {
        if (!workflow.includes(required)) {
          throw new Error(`Symphony workflow lacks ${required}.`);
        }
      }
      return "reviewed admission, active guard, trusted completion, and concurrency contract present";
    }),
    check("runtime:planning-snapshot", async () => {
      planningSource = await loadProtectedJsonFile({
          file: input.paths.planningSnapshotFile,
          label: "Pilot planning snapshot",
          maxBytes: 8 * 1024 * 1024,
        });
      planning = planningSchema.parse(planningSource);
      assertFresh(planning.generatedAt, input.auditedAt, 90);
      if (
        repositoryName(planning.repository) !== input.repository ||
        planning.issueNumber !== input.issueNumber
      ) {
        throw new Error("Planning snapshot binds another repository or issue.");
      }
      if (!planning.planningSafe || planning.blockers.length > 0) {
        throw new Error(`Planning remains blocked: ${planning.blockers.join(", ") || "unsafe"}.`);
      }
      return `fresh planning evidence for issue ${input.issueNumber.toLocaleString()}`;
    }),
    check("runtime:dispatch-intention", async () => {
      dispatchSource = await loadProtectedJsonFile({
          file: input.paths.dispatchIntentionFile,
          label: "Pilot dispatch intention",
          maxBytes: 8 * 1024 * 1024,
        });
      dispatch = dispatchSchema.parse(dispatchSource);
      if (dispatch.status !== "ready") {
        throw new Error(`Dispatch remains blocked: ${dispatch.blockers.join(", ")}.`);
      }
      return dispatch.intention.intentionId;
    }),
    check("runtime:executor-readiness", async () => {
      executorReadiness = selectedExecutorReadinessReportSchema.parse(
        await loadProtectedJsonFile({
          file: input.paths.executorReadinessFile,
          label: "Selected executor readiness",
          maxBytes: 1024 * 1024,
        }),
      );
      assertFresh(executorReadiness.checkedAt, input.auditedAt, 120);
      return `${executorReadiness.hostId}:${executorReadiness.baseHead}:${executorReadiness.transport.configSha256}`;
    }),
    check("runtime:publisher-readiness", async () => {
      publisherReadiness = selectedPublisherReadinessReportSchema.parse(
        await loadProtectedJsonFile({
          file: input.paths.publisherReadinessFile,
          label: "Selected publisher readiness",
          maxBytes: 1024 * 1024,
        }),
      );
      assertFresh(publisherReadiness.checkedAt, input.auditedAt, 120);
      if (!publisherReadiness.selectedRepositories.includes(input.repository)) {
        throw new Error("Selected publisher is not enrolled for the pilot repository.");
      }
      return `${publisherReadiness.hostId}:${publisherReadiness.publisher.sha256}:${publisherReadiness.transport.configSha256}`;
    }),
    check("policy:lifecycle-projection-gate", () => {
      if (!input.publicationEnabled) {
        throw new Error("Lifecycle projection and draft publication remain disabled.");
      }
      return "owner-selected pilot write gate enabled";
    }),
    check("runtime:symphony-executable", async () =>
      await physicalFile({
        file: input.paths.symphonyExecutable,
        label: "Pinned Symphony executable",
        executable: true,
        maxBytes: 512 * 1024 * 1024,
      }),
    ),
    check("runtime:prelaunch-executable", async () =>
      await physicalFile({
        file: path.join(input.paths.releaseRoot, "dist/cli/symphony-prelaunch.js"),
        label: "AubTown prelaunch executable",
        executable: false,
        maxBytes: 2 * 1024 * 1024,
      }),
    ),
    check("runtime:active-guard-executable", async () =>
      await physicalFile({
        file: path.join(input.paths.releaseRoot, "dist/cli/symphony-active-run-guard.js"),
        label: "AubTown active guard executable",
        executable: false,
        maxBytes: 2 * 1024 * 1024,
      }),
    ),
    check("runtime:workspace-preparer-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/prepare-symphony-workspace.js",
        ),
        label: "AubTown remote workspace preparer",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      workspacePreparerSha256 = sha256(await readFile(file));
      return workspacePreparerSha256;
    }),
    check("runtime:workspace-completer-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/complete-symphony-workspace.js",
        ),
        label: "AubTown trusted workspace completer",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      workspaceCompleterSha256 = sha256(await readFile(file));
      return workspaceCompleterSha256;
    }),
    check("runtime:workspace-completion-reader-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/read-symphony-completion.js",
        ),
        label: "AubTown trusted completion reader",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      workspaceCompletionReaderSha256 = sha256(await readFile(file));
      return workspaceCompletionReaderSha256;
    }),
    check("runtime:workspace-adjudicator-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/adjudicate-symphony-completion.js",
        ),
        label: "AubTown trusted adjudicator",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      workspaceAdjudicatorSha256 = sha256(await readFile(file));
      return workspaceAdjudicatorSha256;
    }),
    check("runtime:draft-publisher-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/publish-draft-local.js",
        ),
        label: "AubTown draft publisher",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      draftPublisherSha256 = sha256(await readFile(file));
      return draftPublisherSha256;
    }),
    check("runtime:publisher-ssh-gateway-executable", async () => {
      const file = await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/publisher-ssh-gateway.js",
        ),
        label: "AubTown publisher SSH gateway",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      });
      publisherGatewaySha256 = sha256(await readFile(file));
      return publisherGatewaySha256;
    }),
    check("runtime:node-version-contract", async () => {
      const file = await physicalFile({
        file: path.join(input.paths.releaseRoot, ".nvmrc"),
        label: "AubTown Node version contract",
        executable: false,
        maxBytes: 128,
      });
      const version = (await readFile(file, "utf8")).trim();
      if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
        throw new Error("AubTown Node version contract is invalid.");
      }
      expectedNodeVersion = `v${version}`;
      return expectedNodeVersion;
    }),
    check("runtime:executor-probe-client-executable", async () =>
      await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/probe-executor-readiness.js",
        ),
        label: "AubTown executor probe client",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      }),
    ),
    check("runtime:executor-probe-host-executable", async () =>
      await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/probe-executor-readiness-local.js",
        ),
        label: "AubTown host-local executor probe",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      }),
    ),
    check("runtime:publisher-probe-client-executable", async () =>
      await physicalFile({
        file: path.join(
          input.paths.releaseRoot,
          "dist/cli/probe-publisher-readiness.js",
        ),
        label: "AubTown publisher probe client",
        executable: false,
        maxBytes: 2 * 1_024 * 1_024,
      }),
    ),
    check("authority:claim-broker", async () =>
      await physicalFile({
        file: input.paths.claimBrokerExecutable,
        label: "Freed claim broker",
        executable: true,
        maxBytes: 64 * 1024 * 1024,
      }),
    ),
    check("authority:broker-conformance", async () => {
      const report = brokerConformanceSchema.parse(
        await loadProtectedJsonFile({
          file: input.paths.brokerConformanceReportFile,
          label: "Freed broker conformance report",
          maxBytes: 1024 * 1024,
        }),
      );
      assertFresh(report.checkedAt, input.auditedAt, 600);
      if (report.brokerExecutable !== input.paths.claimBrokerExecutable) {
        throw new Error("Broker conformance tested another executable.");
      }
      if (sha256(await readFile(input.paths.claimBrokerExecutable)) !== report.brokerSha256) {
        throw new Error("Broker executable changed after conformance.");
      }
      const requiredChecks = [
        "broker-integrity",
        "acquire",
        "acquire-replay",
        "changed-operation-replay",
        "show-after-acquire",
        "list-after-acquire",
        "duplicate-acquire",
        "heartbeat-replay",
        "changed-heartbeat-replay",
        "transfer-replay",
        "stale-epoch-fenced",
        "historical-operation-reuse-fenced",
        "show-after-transfer",
        "list-after-transfer",
        "release-replay",
        "show-after-release",
        "list-after-release",
      ];
      const observed = new Set(report.checks.map((candidate) => candidate.id));
      const missing = requiredChecks.filter((candidate) => !observed.has(candidate));
      if (missing.length > 0) {
        throw new Error(`Broker conformance lacks checks: ${missing.join(", ")}.`);
      }
      return `${report.profile}:${report.brokerSha256}`;
    }),
  ]);

  checks.push(
    await check("runtime:pin-and-patch-integrity", async () => {
      if (lock === undefined) {
        throw new Error("Symphony lock did not validate.");
      }
      if (path.basename(path.dirname(input.paths.symphonyExecutable)) !== lock.production.commit) {
        throw new Error("Symphony executable path does not bind the production commit.");
      }
      for (const patch of lock.patches) {
        if (patch.verifiedAgainst !== lock.production.commit) {
          throw new Error(`Patch ${patch.path} targets another Symphony commit.`);
        }
        const patchFile = path.join(input.paths.releaseRoot, patch.path);
        await physicalFile({
          file: patchFile,
          label: `Symphony patch ${patch.path}`,
          executable: false,
          maxBytes: 8 * 1024 * 1024,
        });
        if (sha256(await readFile(patchFile)) !== patch.sha256) {
          throw new Error(`Symphony patch digest changed: ${patch.path}.`);
        }
      }
      for (const capability of [
        "fail-closed-prelaunch-admission-command",
        "fail-closed-active-turn-guard",
        "fail-closed-trusted-completion-hook",
      ]) {
        if (!lock.reviewedCapabilities.includes(capability)) {
          throw new Error(`Symphony lock lacks reviewed capability ${capability}.`);
        }
      }
      return `${lock.patches.length.toLocaleString()} reviewed patches match ${lock.production.commit}`;
    }),
    await check("planning:dispatch-coherence", () => {
      if (planning === undefined || dispatch === undefined || dispatch.status !== "ready") {
        throw new Error("Planning and dispatch evidence are not both ready.");
      }
      const candidate = dispatch.intention.candidateInput;
      const issueUrl = candidate.qualification.issue.url;
      if (
        dispatch.intention.plannedAt !== planning.generatedAt ||
        candidate.now !== planning.generatedAt ||
        repositoryName(candidate.qualification.repository) !== input.repository ||
        repositoryName(candidate.intendedClaim.repository) !== input.repository ||
        candidate.qualification.issue.number !== input.issueNumber ||
        candidate.authorityTask.githubIssue.number !== input.issueNumber ||
        candidate.intendedClaim.issueNumber !== input.issueNumber ||
        candidate.authorityTask.githubIssue.url !== issueUrl
      ) {
        throw new Error("Dispatch intention disagrees with its planning, issue, claim, or task identity.");
      }
      return `${dispatch.intention.sourceDigest}:${candidate.intendedClaim.claimId}`;
    }),
    await check("planning:dispatch-reproduction", async () => {
      if (planningSource === undefined || dispatchSource === undefined) {
        throw new Error("Raw planning and dispatch evidence are unavailable.");
      }
      const enrollments = parseHostEnrollments(
        await loadProtectedJsonFile({
          file: input.paths.hostEnrollmentsFile,
          label: "Host enrollments",
        }),
      );
      const accountProfiles = parseExecutionAccountProfiles(
        await loadProtectedJsonFile({
          file: input.paths.accountProfilesFile,
          label: "Execution account profiles",
        }),
        enrollments,
      );
      const hostWorkspaceRoots = await loadHostWorkspaceRoots(
        input.paths.hostWorkspaceRootsFile,
        enrollments,
      );
      const reproduced = buildStableDispatchIntention({
        snapshot: planningSource as LivePlanningSnapshot,
        accountProfiles,
        hostWorkspaceRoots,
      });
      if (!Buffer.from(canonicalJson(reproduced)).equals(canonicalJson(dispatchSource))) {
        throw new Error("Dispatch intention cannot be reproduced from protected planning inputs.");
      }
      return "dispatch reproduces byte-for-byte from protected source evidence";
    }),
    await check("planning:executor-coherence", () => {
      if (
        dispatch === undefined ||
        dispatch.status !== "ready" ||
        executorReadiness === undefined
      ) {
        throw new Error("Dispatch and executor readiness are not both available.");
      }
      const candidate = dispatch.intention.candidateInput;
      if (
        executorReadiness.hostId !== candidate.intendedClaim.hostId ||
        executorReadiness.transport.hostId !== executorReadiness.hostId ||
        repositoryName(executorReadiness.repository) !== input.repository ||
        executorReadiness.baseHead !== candidate.baseHead ||
        path.dirname(candidate.intendedClaim.worktree) !==
          executorReadiness.worktreeRoot ||
        executorReadiness.preparer.sha256 !== workspacePreparerSha256 ||
        executorReadiness.completer.sha256 !== workspaceCompleterSha256 ||
        executorReadiness.completionReader.sha256 !==
          workspaceCompletionReaderSha256 ||
        executorReadiness.adjudicator.sha256 !== workspaceAdjudicatorSha256 ||
        executorReadiness.node.version !== expectedNodeVersion
      ) {
        throw new Error(
          "Executor readiness disagrees with the selected host, repository, base, workspace root, preparer, completer, completion reader, adjudicator, or Node version.",
        );
      }
      return `${executorReadiness.hostId}:${executorReadiness.helper.sha256}:${executorReadiness.preparer.sha256}:${executorReadiness.completer.sha256}:${executorReadiness.completionReader.sha256}:${executorReadiness.adjudicator.sha256}`;
    }),
    await check("planning:publisher-coherence", () => {
      if (
        dispatch === undefined ||
        dispatch.status !== "ready" ||
        executorReadiness === undefined ||
        publisherReadiness === undefined ||
        draftPublisherSha256 === undefined ||
        publisherGatewaySha256 === undefined ||
        expectedNodeVersion === undefined
      ) {
        throw new Error("Dispatch, executor, and publisher readiness are not all available.");
      }
      const hostId = dispatch.intention.candidateInput.intendedClaim.hostId;
      if (
        publisherReadiness.hostId !== hostId ||
        executorReadiness.hostId !== hostId ||
        publisherReadiness.transport.hostId !== `${hostId}-publisher` ||
        publisherReadiness.transport.user !== "aubtown-publisher" ||
        publisherReadiness.gateway.sha256 !== publisherGatewaySha256 ||
        publisherReadiness.publisher.sha256 !== draftPublisherSha256 ||
        publisherReadiness.node.version !== expectedNodeVersion ||
        !publisherReadiness.selectedRepositories.includes(input.repository) ||
        !publisherReadiness.worktreeRoots.includes(
          executorReadiness.worktreeRoot,
        )
      ) {
        throw new Error(
          "Publisher readiness disagrees with the selected host, forced SSH gateway, dedicated identity, repository, workspace root, entrypoint, or Node version.",
        );
      }
      return `${publisherReadiness.hostId}:${publisherReadiness.runtime.sha256}:${publisherReadiness.gateway.sha256}:${publisherReadiness.publisher.sha256}`;
    }),
  );

  const ordered = checks.sort((left, right) => left.id.localeCompare(right.id));
  const blockers = ordered.filter((candidate) => !candidate.passed).map((candidate) => candidate.id);
  return {
    schemaVersion: 1,
    auditedAt: input.auditedAt,
    repository: input.repository,
    issueNumber: input.issueNumber,
    ready: blockers.length === 0,
    checks: ordered,
    blockers,
  };
}
