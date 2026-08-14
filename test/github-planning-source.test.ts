import { describe, expect, it } from "vitest";
import {
  GitHubLivePlanningReader,
  type GitHubPlanningApi,
} from "../src/adapters/github/planning-source.js";
import { FREED_REPOSITORY } from "./helpers.js";

describe("GitHub live planning reader", () => {
  it("reads one issue, the exact default head, and every open pull request", async () => {
    const calls: number[] = [];
    const api: GitHubPlanningApi = {
      issues: {
        async get(input) {
          expect(input.issue_number).toBe(1_234);
          return {
            data: {
              number: 1_234,
              html_url: "https://github.com/freed-project/freed/issues/1234",
              title: "Deterministic validation",
              body: "Evidence",
              labels: [{ name: "factory:ready" }, "debt"],
              assignees: [{ login: "AubreyF" }],
              state: "open",
              updated_at: "2026-08-13T08:00:00.000Z",
            },
          };
        },
      },
      git: {
        async getRef(input) {
          expect(input.ref).toBe("heads/dev");
          return { data: { object: { sha: "a".repeat(40) } } };
        },
      },
      pulls: {
        async list(input) {
          calls.push(input.page);
          return {
            data:
              input.page === 1
                ? [
                    {
                      number: 77,
                      html_url: "https://github.com/freed-project/freed/pull/77",
                      draft: true,
                      head: { ref: "fix/validation", sha: "b".repeat(40) },
                      base: { ref: "dev" },
                    },
                  ]
                : [],
          };
        },
      },
    };
    const observation = await new GitHubLivePlanningReader(api).read({
      repository: FREED_REPOSITORY,
      issueNumber: 1_234,
      now: "2026-08-13T18:00:00.000Z",
    });
    expect(calls).toEqual([1]);
    expect(observation).toMatchObject({
      baseHead: "a".repeat(40),
      issue: {
        number: 1_234,
        labels: ["debt", "factory:ready"],
        assignees: ["AubreyF"],
      },
      openPullRequests: [
        { number: 77, branch: "fix/validation", draft: true },
      ],
    });
  });

  it("refuses to treat a pull request as the planning issue", async () => {
    const api: GitHubPlanningApi = {
      issues: {
        async get() {
          return {
            data: {
              number: 1_234,
              html_url: "https://github.com/freed-project/freed/pull/1234",
              title: "PR",
              body: "",
              labels: [],
              state: "open",
              updated_at: "2026-08-13T08:00:00.000Z",
              pull_request: {},
            },
          };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "a".repeat(40) } } };
        },
      },
      pulls: {
        async list() {
          return { data: [] };
        },
      },
    };
    await expect(
      new GitHubLivePlanningReader(api).read({
        repository: FREED_REPOSITORY,
        issueNumber: 1_234,
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).rejects.toThrow("not an issue");
  });
});
