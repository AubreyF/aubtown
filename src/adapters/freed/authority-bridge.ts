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
import { assertRuntimeNeutralPilotBinding } from "../../policy/pilot-binding.js";
import {
  FreedClaimBrokerClient,
  admissionFromAcquire,
  type FreedClaimAcquireRequest,
  type FreedClaimReleaseRequest,
} from "./claim-broker.js";

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

const releaseReasonSchema = z.enum([
  "prelaunch-denied",
  "worker-completed",
  "worker-failed",
  "worker-interrupted",
  "reconciled-unlaunched",
]);
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
      env: {},
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
    assertRuntimeNeutralPilotBinding({ binding, now: input.now });
    const broker = this.#brokerExecutable();
    const operationId = randomUUID();
    const bindingDigest = createExecutionAdmissionDigest(binding);
    const domainsDigest = conflictDomainDigest(binding);
    const request: FreedClaimAcquireRequest = {
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
        workLane: binding.qualification.workLane,
        publicationCeiling: "draft-pr" as const,
      },
      requestedAt: input.now,
    };
    const result = await this.#brokerClient(broker).acquire(request);
    if (
      result.operationId !== operationId ||
      result.taskId !== binding.authorityTask.id ||
      result.taskRevision !== binding.authorityTask.revision ||
      result.authorityClaimId !== binding.claim.claimId ||
      result.custodyEpoch !== binding.claim.custodyEpoch ||
      result.bindingDigest !== bindingDigest ||
      result.conflictDomainDigest !== domainsDigest
    ) {
      throw new Error("Freed claim-acquire response does not match the exact dispatch.");
    }
    if (result.admission.bridgeId !== this.id) {
      throw new Error("Freed claim-acquire response names another authority bridge.");
    }
    return assertExecutionAdmission({
      admission: admissionFromAcquire(result),
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
    const client = this.#brokerClient(broker);
    const current = await client.show({
      schemaVersion: 1,
      taskId: admission.taskId,
    });
    if (
      current.taskRevision !== admission.taskRevision ||
      current.bindingDigest !== admission.bindingDigest ||
      current.claim?.claimId !== admission.authorityClaimId
    ) {
      throw new Error("Freed claim changed before exact release.");
    }
    const operationId = randomUUID();
    const request: FreedClaimReleaseRequest = {
      schemaVersion: 1,
      operationId,
      taskId: admission.taskId,
      expectedTaskRevision: admission.taskRevision,
      authorityClaimId: admission.authorityClaimId,
      bindingDigest: admission.bindingDigest,
      custodyEpoch: current.claim.custodyEpoch,
      expectedHeartbeatAt: current.claim.heartbeatAt,
      reason,
      releasedAt,
    };
    const result = await client.release(request);
    if (
      result.operationId !== operationId ||
      result.taskId !== admission.taskId ||
      result.taskRevision !== admission.taskRevision ||
      result.authorityClaimId !== admission.authorityClaimId ||
      result.bindingDigest !== admission.bindingDigest ||
      result.custodyEpoch !== current.claim.custodyEpoch ||
      result.expectedHeartbeatAt !== current.claim.heartbeatAt ||
      result.reason !== reason ||
      result.releasedAt !== releasedAt
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

  #brokerClient(executable: string): FreedClaimBrokerClient {
    return new FreedClaimBrokerClient(this.runner, {
      executable,
      ...(this.options.claimBrokerArgs === undefined
        ? {}
        : { args: this.options.claimBrokerArgs }),
      cwd: this.options.repositoryRoot,
      timeoutMs: this.options.claimCommandTimeoutMs ?? 120_000,
    });
  }
}
