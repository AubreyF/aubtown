import { z } from "zod";
import type { AuthorityBridge, AuthorityInspection } from "../authority.js";
import type { CommandRunner } from "../command-runner.js";
import type { AuthorityTask, QualificationReport } from "../../domain/types.js";
import type {
  ExecutionAdmission,
  ExecutionAdmissionBinding,
} from "../execution-admission.js";

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
    _input: {
      readonly binding: ExecutionAdmissionBinding;
      readonly now: string;
    },
  ): Promise<ExecutionAdmission> {
    throw new Error(
      "Freed task-scoped execution claims are not implemented. Do not overload nightly-writer or provision worker-specific actors.",
    );
  }

  async release(_admission: ExecutionAdmission): Promise<void> {
    throw new Error(
      "Freed task-scoped execution claims are not implemented. No guessed claim may be released.",
    );
  }
}
