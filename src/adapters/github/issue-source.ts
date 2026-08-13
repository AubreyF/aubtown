import type { IssueRecord, RepositoryRef } from "../../domain/types.js";

export interface GitHubIssueListItem {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly body?: string | null | undefined;
  readonly labels: readonly (string | { readonly name?: string | null })[];
  readonly assignees?: readonly { readonly login: string }[] | null | undefined;
  readonly state: string;
  readonly updated_at: string;
  readonly pull_request?: unknown | undefined;
}

export interface GitHubIssuesApi {
  listForRepo(input: {
    readonly owner: string;
    readonly repo: string;
    readonly state: "open";
    readonly labels: string;
    readonly per_page: number;
    readonly page: number;
  }): Promise<{ readonly data: readonly GitHubIssueListItem[] }>;
}

function labelName(label: GitHubIssueListItem["labels"][number]): string | undefined {
  if (typeof label === "string") {
    return label;
  }
  return label.name ?? undefined;
}

export class GitHubIssueSource {
  constructor(private readonly api: GitHubIssuesApi) {}

  async readOpenDebt(repository: RepositoryRef): Promise<readonly IssueRecord[]> {
    const issues: IssueRecord[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.api.listForRepo({
        owner: repository.owner,
        repo: repository.name,
        state: "open",
        labels: "debt",
        per_page: 100,
        page,
      });
      for (const item of response.data) {
        if (item.pull_request !== undefined) {
          continue;
        }
        issues.push({
          number: item.number,
          url: item.html_url,
          title: item.title,
          body: item.body ?? "",
          labels: item.labels.map(labelName).filter((name): name is string => name !== undefined),
          assignees: (item.assignees ?? []).map((assignee) => assignee.login),
          state: item.state === "open" ? "open" : "closed",
          updatedAt: item.updated_at,
        });
      }
      if (response.data.length < 100) {
        break;
      }
    }
    return issues.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.number - right.number,
    );
  }
}
