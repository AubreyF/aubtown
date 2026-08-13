import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuthorityBridge,
  AuthorityInspection,
  ExecutionAuthorityLease,
} from "../authority.js";
import type { CommandRunner } from "../command-runner.js";
import type { AuthorityTask, QualificationReport } from "../../domain/types.js";

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
  readonly workerActor?: string;
  readonly workerLeaseName?: string;
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
    report: QualificationReport,
    workerId: string,
  ): Promise<ExecutionAuthorityLease> {
    const actor = this.options.workerActor;
    const leaseName = this.options.workerLeaseName;
    if (actor === undefined || leaseName === undefined) {
      throw new Error(
        "Freed worker-specific authority is not provisioned. Do not overload nightly-writer.",
      );
    }
    if (!report.eligible) {
      throw new Error("An ineligible issue cannot acquire execution authority.");
    }
    const token = randomBytes(32).toString("base64url");
    const operationId = randomUUID();
    const output = await this.runner.run({
      executable: "npm",
      args: [
        "run",
        "--silent",
        "automation:actors",
        "--",
        "acquire",
        "--actor",
        actor,
      ],
      cwd: this.options.repositoryRoot,
      env: {
        ...process.env,
        FREEDWORKS_WORKER_ID: workerId,
        FREEDWORKS_ISSUE_NUMBER: String(report.issue.number),
        FREED_AUTOMATION_LEASE_OPERATION_ID: operationId,
        FREED_AUTOMATION_LEASE_TOKEN: token,
      },
    });
    const acquired = z
      .object({ expiresAt: z.iso.datetime() })
      .passthrough()
      .parse(JSON.parse(output.stdout));
    return { actor, leaseName, token, expiresAt: acquired.expiresAt };
  }

  async release(lease: ExecutionAuthorityLease): Promise<void> {
    await this.runner.run({
      executable: this.options.nodeExecutable,
      args: [
        "scripts/automation-control.mjs",
        "lease",
        "release",
        "--state-root",
        this.options.stateRoot,
        "--name",
        lease.leaseName,
      ],
      cwd: this.options.repositoryRoot,
      env: {
        ...process.env,
        FREED_AUTOMATION_LEASE_OPERATION_ID: randomUUID(),
        FREED_AUTOMATION_LEASE_TOKEN: lease.token,
      },
    });
  }
}
