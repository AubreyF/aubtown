import { Octokit } from "@octokit/rest";
import type { GitHubAppBroker } from "../credentials/github-app-broker.js";
import { FACTORY_LABELS } from "../domain/types.js";
import {
  STATUS_COMMENT_MARKER,
  type StatusProjection,
} from "./status.js";

export interface ExistingIssueComment {
  readonly id: number;
  readonly body: string | null;
  readonly authorLogin: string | null;
}

export interface ProjectionMutationPlan {
  readonly allowed: boolean;
  readonly reason: "ready" | "duplicate-managed-comments" | "invalid-body";
  readonly labels: readonly string[];
  readonly labelsChanged: boolean;
  readonly comment: {
    readonly action: "none" | "create" | "update";
    readonly id?: number;
    readonly body: string;
  };
}

export function planProjectionMutation(input: {
  readonly currentLabels: readonly string[];
  readonly comments: readonly ExistingIssueComment[];
  readonly machineAuthorLogin: string;
  readonly projection: StatusProjection;
}): ProjectionMutationPlan {
  if (
    !input.projection.commentBody.startsWith("(AI Generated).\n\n") ||
    !input.projection.commentBody.includes(STATUS_COMMENT_MARKER)
  ) {
    return {
      allowed: false,
      reason: "invalid-body",
      labels: input.currentLabels,
      labelsChanged: false,
      comment: { action: "none", body: input.projection.commentBody },
    };
  }
  const factoryLabels = new Set<string>(FACTORY_LABELS);
  const labels = [
    ...input.currentLabels.filter((label) => !factoryLabels.has(label)),
    ...input.projection.labelsToAdd,
  ].filter((label, index, all) => all.indexOf(label) === index).sort();
  const currentSorted = [...new Set(input.currentLabels)].sort();
  const managed = input.comments.filter(
    (comment) =>
      comment.authorLogin === input.machineAuthorLogin &&
      comment.body?.includes(STATUS_COMMENT_MARKER),
  );
  if (managed.length > 1) {
    return {
      allowed: false,
      reason: "duplicate-managed-comments",
      labels,
      labelsChanged: false,
      comment: { action: "none", body: input.projection.commentBody },
    };
  }
  const existing = managed[0];
  return {
    allowed: true,
    reason: "ready",
    labels,
    labelsChanged: JSON.stringify(labels) !== JSON.stringify(currentSorted),
    comment:
      existing === undefined
        ? { action: "create", body: input.projection.commentBody }
        : existing.body === input.projection.commentBody
          ? { action: "none", id: existing.id, body: input.projection.commentBody }
          : { action: "update", id: existing.id, body: input.projection.commentBody },
  };
}

export interface ProjectionWriteReceipt {
  readonly repository: string;
  readonly issueNumber: number;
  readonly labelsChanged: boolean;
  readonly commentAction: "none" | "create" | "update";
  readonly tokenExpiresAt: string;
}

export class GitHubProjectionWriter {
  constructor(
    private readonly broker: GitHubAppBroker,
    private readonly machineAuthorLogin: string,
    private readonly octokitFactory: (token: string) => Octokit =
      (token) => new Octokit({ auth: token }),
  ) {}

  async write(input: {
    readonly owner: string;
    readonly repository: string;
    readonly issueNumber: number;
    readonly projection: StatusProjection;
    readonly projectionApproved: boolean;
  }): Promise<ProjectionWriteReceipt> {
    const repository = `${input.owner}/${input.repository}`;
    const token = await this.broker.mintCoordinatorProjection({
      repository,
      projectionApproved: input.projectionApproved,
    });
    const octokit = this.octokitFactory(token.token);
    const [issue, comments] = await Promise.all([
      octokit.rest.issues.get({
        owner: input.owner,
        repo: input.repository,
        issue_number: input.issueNumber,
      }),
      octokit.paginate(octokit.rest.issues.listComments, {
        owner: input.owner,
        repo: input.repository,
        issue_number: input.issueNumber,
        per_page: 100,
      }),
    ]);
    const plan = planProjectionMutation({
      currentLabels: issue.data.labels.map((label) =>
        typeof label === "string" ? label : label.name ?? "",
      ).filter(Boolean),
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? null,
        authorLogin: comment.user?.login ?? null,
      })),
      machineAuthorLogin: this.machineAuthorLogin,
      projection: input.projection,
    });
    if (!plan.allowed) {
      throw new Error(`Lifecycle projection refused: ${plan.reason}.`);
    }
    if (plan.labelsChanged) {
      await octokit.rest.issues.setLabels({
        owner: input.owner,
        repo: input.repository,
        issue_number: input.issueNumber,
        labels: [...plan.labels],
      });
    }
    if (plan.comment.action === "create") {
      await octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repository,
        issue_number: input.issueNumber,
        body: plan.comment.body,
      });
    } else if (plan.comment.action === "update" && plan.comment.id !== undefined) {
      await octokit.rest.issues.updateComment({
        owner: input.owner,
        repo: input.repository,
        comment_id: plan.comment.id,
        body: plan.comment.body,
      });
    }
    return {
      repository,
      issueNumber: input.issueNumber,
      labelsChanged: plan.labelsChanged,
      commentAction: plan.comment.action,
      tokenExpiresAt: token.expiresAt,
    };
  }
}
