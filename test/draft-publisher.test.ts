import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandRunner } from "../src/adapters/command-runner.js";
import type {
  ExactValidationReceipt,
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import {
  GitHubDraftPublisher,
  GitHttpsBranchPublisher,
  type DraftPullRequestClient,
  type DraftPullRequestSnapshot,
} from "../src/publication/draft-publisher.js";
import { planDraftPublication } from "../src/publication/policy.js";
import { decideQuota } from "../src/policy/quota.js";
import {
  authorityTask,
  claim,
  FREED_REPOSITORY,
  report,
  usage,
} from "./helpers.js";

const head = "c".repeat(40);
const baseHead = "a".repeat(40);
const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  branch: claim().branch,
  worktree: claim().worktree,
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead,
  head,
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

const validation: ExactValidationReceipt = {
  schemaVersion: 1,
  kind: "exact-validation",
  workProduct,
  passed: true,
  commands: [
    {
      argv: ["/opt/aubtown/node/bin/node", "test.js"],
      cwd: workProduct.worktree,
      exitCode: 0,
      outputDigest: "f".repeat(64),
      durationMs: 100,
    },
  ],
  completedAt: "2026-08-13T18:00:30.000Z",
  summary: "Validation passed.",
};

const review: IndependentReviewReceipt = {
  schemaVersion: 1,
  kind: "independent-review",
  workProduct,
  reviewer: {
    driverId: "codex-app-server-v1",
    threadId: "review-thread",
    turnId: "review-turn",
  },
  verdict: "pass",
  findings: [],
  completedAt: "2026-08-13T18:00:45.000Z",
  summary: "Review passed.",
};

function plan(existingPullRequest?: {
  readonly number: number;
  readonly branch: string;
  readonly head: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
}) {
  const activeClaim = claim();
  return planDraftPublication({
    repository: FREED_REPOSITORY,
    qualification: report(),
    claim: activeClaim,
    currentClaim: activeClaim,
    authorityTask: authorityTask(),
    authorityActive: true,
    quota: decideQuota({ snapshot: usage(), now: "2026-08-13T08:01:00.000Z" }),
    publicationCeiling: "draft-pr",
    head,
    workProduct,
    validation,
    review,
    title: "fix: make validation deterministic",
    bodySummary: "Makes validation ordering deterministic.",
    ...(existingPullRequest === undefined ? {} : { existingPullRequest }),
    now: "2026-08-13T08:01:00.000Z",
  });
}

function snapshot(overrides: Partial<DraftPullRequestSnapshot> = {}): DraftPullRequestSnapshot {
  return {
    number: 42,
    url: "https://github.com/freed-project/freed/pull/42",
    state: "open",
    draft: true,
    branch: workProduct.branch,
    head,
    base: "dev",
    title: "fix: make validation deterministic",
    body:
      "(AI Generated).\n\nMakes validation ordering deterministic.\n\nCloses no issue automatically. Handoff for #1234.",
    ...overrides,
  };
}

function publisherFixture(input: {
  remoteHead: string | null;
  pullRequests?: DraftPullRequestSnapshot[];
}) {
  let remoteHead = input.remoteHead;
  let pullRequests = input.pullRequests ?? [];
  const pushes: Array<Record<string, unknown>> = [];
  const client: DraftPullRequestClient = {
    readBranchHead: async () => remoteHead,
    findOpenByBranch: async () => pullRequests,
    createDraft: async (request) => {
      const created = snapshot({
        number: 42,
        branch: request.branch,
        head: remoteHead ?? "",
        base: request.base,
        title: request.title,
        body: request.body,
      });
      pullRequests = [created];
      return created;
    },
    updateDraft: async (request) => {
      const updated = snapshot({
        number: request.number,
        head: remoteHead ?? "",
        title: request.title,
        body: request.body,
      });
      pullRequests = [updated];
      return updated;
    },
  };
  const publisher = new GitHubDraftPublisher(
    {
      mintDraftPublisher: async ({ repository }) => ({
        token: "installation-secret",
        expiresAt: "2099-08-13T19:00:00.000Z",
        repository,
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
    {
      inspect: async () => ({
        head: workProduct.head,
        patchDigest: workProduct.patchDigest,
      }),
    },
    {
      push: async (request) => {
        pushes.push(request);
        remoteHead = request.head;
      },
    },
    () => client,
    () => new Date("2026-08-13T18:02:00.000Z"),
  );
  return { publisher, pushes, client };
}

describe("GitHubDraftPublisher", () => {
  it("pushes and creates one exact draft, then reconciles a crash retry", async () => {
    const fixture = publisherFixture({ remoteHead: null });
    const publicationPlan = plan();
    expect(publicationPlan.reasons).toEqual([]);
    const first = await fixture.publisher.publish(publicationPlan);
    const second = await fixture.publisher.publish(plan());
    expect(second).toEqual(first);
    expect(fixture.pushes).toHaveLength(1);
    expect(fixture.pushes[0]).toMatchObject({
      repository: "freed-project/freed",
      branch: workProduct.branch,
      head,
    });
    expect(first).toMatchObject({
      draft: true,
      pullRequestNumber: 42,
      checkpointReference: workProduct.checkpointReference,
    });
  });

  it("updates only the observed draft and uses its prior head as the lease", async () => {
    const priorHead = "b".repeat(40);
    const fixture = publisherFixture({
      remoteHead: priorHead,
      pullRequests: [snapshot({ head: priorHead })],
    });
    await fixture.publisher.publish(
      plan({
        number: 42,
        branch: workProduct.branch,
        head: priorHead,
        draft: true,
        state: "open",
      }),
    );
    expect(fixture.pushes[0]).toMatchObject({ expectedRemoteHead: priorHead });
  });

  it("refuses a branch that changed after planning", async () => {
    const fixture = publisherFixture({ remoteHead: "9".repeat(40) });
    await expect(fixture.publisher.publish(plan())).rejects.toThrow(
      "changed after publication planning",
    );
    expect(fixture.pushes).toHaveLength(0);
  });
});

describe("GitHttpsBranchPublisher", () => {
  it("keeps the installation token out of Git arguments", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = {
      run: async (request) => {
        calls.push(request);
        const operation = request.args[0];
        return {
          stdout:
            operation === "symbolic-ref"
              ? `${workProduct.branch}\n`
              : operation === "rev-parse"
                ? `${head}\n`
                : "",
          stderr: "",
        };
      },
    };
    await new GitHttpsBranchPublisher(runner, "/usr/bin/git").push({
      repositoryRoot: workProduct.worktree,
      repository: "freed-project/freed",
      branch: workProduct.branch,
      head,
      token: "installation-secret",
    });
    const push = calls.find((call) => call.args[0] === "push");
    expect(push?.args.join(" ")).not.toContain("installation-secret");
    expect(push?.env?.AUBTOWN_GITHUB_TOKEN).toBe("installation-secret");
    expect(push?.args).toContain(
      `--force-with-lease=refs/heads/${workProduct.branch}:`,
    );
  });
});
