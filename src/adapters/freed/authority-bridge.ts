import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type {
  AuthorityBridge,
  AuthorityInspection,
  ExecutionClaimReleaseReason,
} from "../authority.js";
import type { CommandRunner } from "../command-runner.js";
import type { AuthorityTask, QualificationReport } from "../../domain/types.js";
import type {
  ExecutionAdmission,
  ExecutionAdmissionBinding,
} from "../execution-admission.js";
import {
  assertExecutionAdmission,
  createExecutionAdmissionDigest,
  executionAdmissionBindingSchema,
  executionAdmissionSchema,
} from "../execution-admission.js";
import { canonicalJson } from "../../security/canonical-json.js";

const freedTaskSchema = z.object({
  taskId: z.string(),
  state: z.string(),
  revision: z.number().int().positive(),
  observerAuthority: z.string(),
  providerAuthority: z.string(),
  details: z.object({
    behavioral: z.boolean(),
    estimatedMinutes: z.number().int().positive(),
    githubIssue: z.object({
      number: z.number().int().positive(),
      url: z.url(),
    }),
  }).passthrough(),
});

const taskListOutputSchema = z.object({
  action: z.literal("task.list"),
  result: z.object({
    tasks: z.array(freedTaskSchema),
  }).passthrough(),
});

const acquireOutputSchema = z.object({
  action: z.literal("task.claim-acquire"),
  result: z.object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    authorityClaimId: z.string().min(1),
    custodyEpoch: z.number().int().positive(),
    bindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    conflictDomainDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    admission: executionAdmissionSchema,
  }).strict(),
}).strict();

const releaseReasonSchema = z.enum([
  "prelaunch-denied",
  "worker-completed",
  "worker-failed",
  "worker-interrupted",
  "reconciled-unlaunched",
]);
const CLAIM_MAX_AGE_SECONDS = 120;

const releaseOutputSchema = z.object({
  action: z.literal("task.claim-release"),
  result: z.object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    authorityClaimId: z.string().min(1),
    bindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    reason: releaseReasonSchema,
    releasedAt: z.iso.datetime(),
  }).strict(),
}).strict();

function toAuthorityTask(task: z.infer<typeof freedTaskSchema>): AuthorityTask {
  return {
    id: task.taskId,
    revision: task.revision,
    state: task.state,
    githubIssue: task.details.githubIssue,
    executionAuthority: task.observerAuthority,
    providerAuthority: task.providerAuthority,
    behavioral: task.details.behavioral,
    estimatedMinutes: task.details.estimatedMinutes,
  };
}

export interface FreedAuthorityBridgeOptions {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly nodeExecutable: string;
  readonly claimBrokerExecutable?: string;
  readonly claimBrokerArgs?: readonly string[];
  readonly claimCommandTimeoutMs?: number;
}

function canonicalJsonText(value: unknown): string {
  return Buffer.from(canonicalJson(value)).toString("utf8");
}

function conflictDomainDigest(binding: ExecutionAdmissionBinding): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        [...new Set(binding.claim.conflictDomains)].sort((left, right) =>
          left.localeCompare(right),
        ),
      ),
    )
    .digest("hex");
}

function normalizedConflictDomains(domains: readonly string[]): readonly string[] {
  return [...new Set(domains)].sort((left, right) => left.localeCompare(right));
}

function assertPilotBinding(binding: ExecutionAdmissionBinding, now: string): void {
  const issue = binding.qualification.issue;
  const task = binding.authorityTask;
  const qualificationDomains = normalizedConflictDomains(
    binding.qualification.conflictDomains,
  );
  const claimDomains = normalizedConflictDomains(binding.claim.conflictDomains);
  const nowMs = Date.parse(now);
  const claimedAtMs = Date.parse(binding.claim.claimedAt);
  const repositoriesMatch =
    binding.qualification.repository.owner === binding.claim.repository.owner &&
    binding.qualification.repository.name === binding.claim.repository.name &&
    binding.qualification.repository.defaultBranch ===
      binding.claim.repository.defaultBranch;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(claimedAtMs) ||
    claimedAtMs > nowMs ||
    nowMs - claimedAtMs > CLAIM_MAX_AGE_SECONDS * 1_000 ||
    issue.state !== "open" ||
    !issue.labels.includes("debt") ||
    !issue.labels.includes("factory:ready") ||
    !binding.qualification.eligible ||
    binding.qualification.workLane !== "runtime-neutral" ||
    binding.qualification.evidence.behavioral !== false ||
    task.behavioral ||
    task.state !== "approved_for_pr" ||
    !["pr-only", "merge-safe"].includes(task.executionAuthority) ||
    task.providerAuthority !== "forbidden" ||
    task.githubIssue.number !== issue.number ||
    task.githubIssue.url !== issue.url ||
    binding.claim.issueNumber !== issue.number ||
    !repositoriesMatch ||
    claimDomains.length === 0 ||
    !Buffer.from(canonicalJson(qualificationDomains)).equals(
      canonicalJson(claimDomains),
    )
  ) {
    throw new Error("Freed claim acquisition is outside the runtime-neutral pilot policy.");
  }
}

export class FreedAuthorityBridge implements AuthorityBridge {
  readonly id = "freed-authority-v1";

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: FreedAuthorityBridgeOptions,
  ) {}

  async inspect(report: QualificationReport): Promise<AuthorityInspection> {
    const output = await this.runner.run({
      executable: this.options.nodeExecutable,
      args: [
        "scripts/automation-control.mjs",
        "task",
        "list",
        "--state-root",
        this.options.stateRoot,
      ],
      cwd: this.options.repositoryRoot,
    });
    const parsed = taskListOutputSchema.parse(JSON.parse(output.stdout));
    const task = parsed.result.tasks
      .map(toAuthorityTask)
      .find(
        (candidate) =>
          candidate.githubIssue.number === report.issue.number &&
          candidate.githubIssue.url === report.issue.url &&
          candidate.state !== "closed",
      );
    if (task === undefined) {
      return { active: false, reason: "matching-active-task-not-found" };
    }
    return { task, active: true, reason: "matching-active-task" };
  }

  async acquire(
    input: {
      readonly binding: ExecutionAdmissionBinding;
      readonly now: string;
    },
  ): Promise<ExecutionAdmission> {
    const binding = executionAdmissionBindingSchema.parse(input.binding);
    assertPilotBinding(binding, input.now);
    const broker = this.#brokerExecutable();
    const operationId = randomUUID();
    const bindingDigest = createExecutionAdmissionDigest(binding);
    const domainsDigest = conflictDomainDigest(binding);
    const request = {
      schemaVersion: 1,
      operationId,
      taskId: binding.authorityTask.id,
      expectedTaskRevision: binding.authorityTask.revision,
      bindingDigest,
      claim: {
        claimId: binding.claim.claimId,
        githubIssue: binding.authorityTask.githubIssue,
        custodyEpoch: binding.claim.custodyEpoch,
        hostId: binding.claim.hostId,
        workerId: binding.claim.workerId,
        branch: binding.claim.branch,
        worktree: binding.claim.worktree,
        conflictDomains: [...binding.claim.conflictDomains],
        conflictDomainDigest: domainsDigest,
        claimedAt: binding.claim.claimedAt,
        baseHead: binding.baseHead,
        accountId: binding.accountId,
        driverId: binding.driverId,
        target: binding.target,
        publicationCeiling: "draft-pr" as const,
      },
      requestedAt: input.now,
    };
    const output = await this.#runClaimCommand(
      broker,
      "claim-acquire",
      request,
    );
    const parsed = acquireOutputSchema.parse(JSON.parse(output.stdout));
    if (
      parsed.result.operationId !== operationId ||
      parsed.result.taskId !== binding.authorityTask.id ||
      parsed.result.taskRevision !== binding.authorityTask.revision ||
      parsed.result.authorityClaimId !== binding.claim.claimId ||
      parsed.result.custodyEpoch !== binding.claim.custodyEpoch ||
      parsed.result.bindingDigest !== bindingDigest ||
      parsed.result.conflictDomainDigest !== domainsDigest
    ) {
      throw new Error("Freed claim-acquire response does not match the exact dispatch.");
    }
    if (parsed.result.admission.bridgeId !== this.id) {
      throw new Error("Freed claim-acquire response names another authority bridge.");
    }
    return assertExecutionAdmission({
      admission: parsed.result.admission,
      binding,
      now: input.now,
    });
  }

  async release(input: {
    readonly admission: ExecutionAdmission;
    readonly reason: ExecutionClaimReleaseReason;
    readonly now: string;
  }): Promise<void> {
    const admission = executionAdmissionSchema.parse(input.admission);
    const reason = releaseReasonSchema.parse(input.reason);
    const releasedAt = z.iso.datetime().parse(input.now);
    const broker = this.#brokerExecutable();
    const operationId = randomUUID();
    const request = {
      schemaVersion: 1,
      operationId,
      taskId: admission.taskId,
      expectedTaskRevision: admission.taskRevision,
      authorityClaimId: admission.authorityClaimId,
      bindingDigest: admission.bindingDigest,
      reason,
      releasedAt,
    };
    const output = await this.#runClaimCommand(
      broker,
      "claim-release",
      request,
    );
    const parsed = releaseOutputSchema.parse(JSON.parse(output.stdout));
    if (
      parsed.result.operationId !== operationId ||
      parsed.result.taskId !== admission.taskId ||
      parsed.result.taskRevision !== admission.taskRevision ||
      parsed.result.authorityClaimId !== admission.authorityClaimId ||
      parsed.result.bindingDigest !== admission.bindingDigest ||
      parsed.result.reason !== reason ||
      parsed.result.releasedAt !== releasedAt
    ) {
      throw new Error("Freed claim-release response does not match the exact admission.");
    }
  }

  #brokerExecutable(): string {
    const executable = this.options.claimBrokerExecutable;
    if (executable === undefined) {
      throw new Error(
        "Freed task-scoped execution claims require the reviewed coordinator broker.",
      );
    }
    if (!path.isAbsolute(executable)) {
      throw new Error("Freed coordinator broker path must be absolute.");
    }
    return executable;
  }

  async #runClaimCommand(
    executable: string,
    operation: "claim-acquire" | "claim-release",
    request: unknown,
  ) {
    const command = {
      executable,
      args: [
        ...(this.options.claimBrokerArgs ?? []),
        "task",
        operation,
        "--request-json",
        canonicalJsonText(request),
      ],
      cwd: this.options.repositoryRoot,
      env: {},
      timeoutMs: this.options.claimCommandTimeoutMs ?? 30_000,
      maxBufferBytes: 1024 * 1024,
    } as const;
    try {
      return await this.runner.run(command);
    } catch {
      return await this.runner.run(command);
    }
  }
}
