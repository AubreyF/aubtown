import type { IssueRecord, RepositoryRef } from "../../domain/types.js";
import type {
  GitHubPlanningObservation,
  GitHubPlanningReader,
  PlanningPullRequest,
} from "../../orchestration/live-planning-snapshot.js";

const GIT_SHA = /^[0-9a-f]{40}$/u;

interface GitHubLabel {
  readonly name?: string | null;
}

interface GitHubAssignee {
  readonly login: string;
}

export interface GitHubPlanningIssue {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly body?: string | null;
  readonly labels: readonly (string | GitHubLabel)[];
  readonly assignees?: readonly GitHubAssignee[] | null;
  readonly state: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}

export interface GitHubPlanningPullRequest {
  readonly number: number;
  readonly html_url: string;
  readonly draft?: boolean | null;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly base: {
    readonly ref: string;
  };
}

export interface GitHubPlanningApi {
  readonly issues: {
    get(input: {
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
    }): Promise<{ readonly data: GitHubPlanningIssue }>;
  };
  readonly git: {
    getRef(input: {
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
    }): Promise<{ readonly data: { readonly object: { readonly sha: string } } }>;
  };
  readonly pulls: {
    list(input: {
      readonly owner: string;
      readonly repo: string;
      readonly state: "open";
      readonly per_page: number;
      readonly page: number;
    }): Promise<{ readonly data: readonly GitHubPlanningPullRequest[] }>;
  };
}

function labelName(label: string | GitHubLabel): string | undefined {
  return typeof label === "string" ? label : (label.name ?? undefined);
}

function issueRecord(issue: GitHubPlanningIssue): IssueRecord {
  if (issue.pull_request !== undefined) {
    throw new Error("Planning target is a pull request, not an issue.");
  }
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels
      .map(labelName)
      .filter((name): name is string => name !== undefined)
      .sort(),
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login)
      .sort(),
    state: issue.state === "open" ? "open" : "closed",
    updatedAt: issue.updated_at,
  };
}

function pullRequest(pull: GitHubPlanningPullRequest): PlanningPullRequest {
  if (!GIT_SHA.test(pull.head.sha)) {
    throw new Error("GitHub pull request head is not a full Git object ID.");
  }
  return {
    number: pull.number,
    url: pull.html_url,
    branch: pull.head.ref,
    head: pull.head.sha,
    base: pull.base.ref,
    draft: pull.draft === true,
  };
}

export class GitHubLivePlanningReader implements GitHubPlanningReader {
  constructor(private readonly api: GitHubPlanningApi) {}

  async read(input: {
    readonly repository: RepositoryRef;
    readonly issueNumber: number;
    readonly now: string;
  }): Promise<GitHubPlanningObservation> {
    const common = {
      owner: input.repository.owner,
      repo: input.repository.name,
    };
    const [issueResponse, refResponse, openPullRequests] = await Promise.all([
      this.api.issues.get({ ...common, issue_number: input.issueNumber }),
      this.api.git.getRef({
        ...common,
        ref: `heads/${input.repository.defaultBranch}`,
      }),
      this.#readOpenPullRequests(common),
    ]);
    if (issueResponse.data.number !== input.issueNumber) {
      throw new Error("GitHub returned a different planning issue.");
    }
    if (!GIT_SHA.test(refResponse.data.object.sha)) {
      throw new Error("GitHub default branch head is not a full Git object ID.");
    }
    return {
      observedAt: input.now,
      issue: issueRecord(issueResponse.data),
      baseHead: refResponse.data.object.sha,
      openPullRequests,
    };
  }

  async #readOpenPullRequests(common: {
    readonly owner: string;
    readonly repo: string;
  }): Promise<readonly PlanningPullRequest[]> {
    const result: PlanningPullRequest[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.api.pulls.list({
        ...common,
        state: "open",
        per_page: 100,
        page,
      });
      result.push(...response.data.map(pullRequest));
      if (response.data.length < 100) {
        break;
      }
    }
    return result.sort((left, right) => left.number - right.number);
  }
}
