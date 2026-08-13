import { describe, expect, it } from "vitest";
import {
  GitHubIssueSource,
  type GitHubIssuesApi,
} from "../src/adapters/github/issue-source.js";
import { FREED_REPOSITORY } from "./helpers.js";

describe("GitHub issue source", () => {
  it("reads only open debt issues, excludes pull requests, and sorts newest first", async () => {
    const api: GitHubIssuesApi = {
      async listForRepo(input) {
        expect(input).toMatchObject({
          owner: "freed-project",
          repo: "freed",
          labels: "debt",
          state: "open",
        });
        return {
          data: [
            {
              number: 2,
              html_url: "https://github.com/freed-project/freed/issues/2",
              title: "Older issue",
              body: null,
              labels: ["debt"],
              assignees: [],
              state: "open",
              updated_at: "2026-08-12T00:00:00.000Z",
            },
            {
              number: 3,
              html_url: "https://github.com/freed-project/freed/pull/3",
              title: "A pull request",
              body: "",
              labels: ["debt"],
              state: "open",
              updated_at: "2026-08-13T01:00:00.000Z",
              pull_request: {},
            },
            {
              number: 1,
              html_url: "https://github.com/freed-project/freed/issues/1",
              title: "Newer issue",
              body: "Evidence",
              labels: [{ name: "debt" }, { name: "factory:ready" }],
              assignees: [{ login: "AubreyF" }],
              state: "open",
              updated_at: "2026-08-13T00:00:00.000Z",
            },
          ],
        };
      },
    };
    const result = await new GitHubIssueSource(api).readOpenDebt(FREED_REPOSITORY);
    expect(result.map((issue) => issue.number)).toEqual([1, 2]);
    expect(result[0]?.labels).toEqual(["debt", "factory:ready"]);
  });
});
