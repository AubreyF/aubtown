import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { WorkProductStateInspector } from "../adjudication/validation-runner.js";
import { workProductIdentitySchema } from "../adjudication/receipts.js";
import type {
  GitHubAppBroker,
  InstallationTokenReceipt,
} from "../credentials/github-app-broker.js";
import type { PublicationPlan } from "./policy.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const FORBIDDEN_AUTHORSHIP = /\b(?:codex|symphony|openhands|openai|agent)\b/iu;
const CONVENTIONAL_TITLE = /^(?:feat|fix|chore|docs|refactor|perf|style|test)(?:\([^)]+\))?: .+/u;

export interface DraftPullRequestSnapshot {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly branch: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface DraftPullRequestClient {
  readBranchHead(owner: string, repository: string, branch: string): Promise<string | null>;
  findOpenByBranch(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<readonly DraftPullRequestSnapshot[]>;
  createDraft(input: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<DraftPullRequestSnapshot>;
  updateDraft(input: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
  }): Promise<DraftPullRequestSnapshot>;
}

export interface GitBranchPublisher {
  push(input: {
    readonly repositoryRoot: string;
    readonly repository: string;
    readonly branch: string;
    readonly head: string;
    readonly expectedRemoteHead?: string;
    readonly token: string;
  }): Promise<void>;
}

export const draftPublicationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(REPOSITORY),
  checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  branch: z.string().min(1),
  head: z.string().regex(GIT_SHA),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.url(),
  draft: z.literal(true),
  publishedAt: z.iso.datetime(),
  tokenExpiresAt: z.iso.datetime(),
}).strict();

export type DraftPublicationReceipt = z.infer<
  typeof draftPublicationReceiptSchema
>;

export class GitHttpsBranchPublisher implements GitBranchPublisher {
  constructor(
    private readonly runner: CommandRunner,
    private readonly gitExecutable: string,
  ) {}

  async push(input: {
    readonly repositoryRoot: string;
    readonly repository: string;
    readonly branch: string;
    readonly head: string;
    readonly expectedRemoteHead?: string;
    readonly token: string;
  }): Promise<void> {
    if (!REPOSITORY.test(input.repository) || !GIT_SHA.test(input.head)) {
      throw new Error("Draft push has an invalid repository or head.");
    }
    if (
      input.expectedRemoteHead !== undefined &&
      !GIT_SHA.test(input.expectedRemoteHead)
    ) {
      throw new Error("Draft push has an invalid expected remote head.");
    }
    if (!path.isAbsolute(this.gitExecutable)) {
      throw new Error("Draft push Git executable must be absolute.");
    }
    const gitExecutable = await realpath(this.gitExecutable);
    const gitStats = await lstat(gitExecutable);
    if (
      !gitStats.isFile() ||
      gitStats.isSymbolicLink() ||
      (gitStats.mode & 0o111) === 0 ||
      (gitStats.mode & 0o022) !== 0
    ) {
      throw new Error("Draft push Git executable is not a trusted physical file.");
    }
    await this.runner.run({
      executable: gitExecutable,
      args: ["check-ref-format", "--branch", input.branch],
      cwd: input.repositoryRoot,
    });
    const branch = await this.#line(gitExecutable, input.repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const head = await this.#line(gitExecutable, input.repositoryRoot, ["rev-parse", "HEAD"]);
    const status = await this.#line(gitExecutable, input.repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (branch !== input.branch || head !== input.head || status !== "") {
      throw new Error("Draft push worktree does not match the admitted plan.");
    }
    const temporary = await mkdtemp(path.join(os.tmpdir(), "aubtown-askpass-"));
    const askpass = path.join(temporary, "git-askpass.sh");
    try {
      await writeFile(
        askpass,
        [
          "#!/bin/sh",
          "case \"$1\" in",
          "  *Username*) printf '%s\\n' 'x-access-token' ;;",
          "  *) printf '%s\\n' \"$AUBTOWN_GITHUB_TOKEN\" ;;",
          "esac",
          "",
        ].join("\n"),
        { flag: "wx", mode: 0o700 },
      );
      const stats = await lstat(askpass);
      if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
        throw new Error("Draft push askpass helper is not private.");
      }
      const lease = `refs/heads/${input.branch}:${input.expectedRemoteHead ?? ""}`;
      await this.runner.run({
        executable: gitExecutable,
        args: [
          "push",
          `--force-with-lease=${lease}`,
          `https://github.com/${input.repository}.git`,
          `${input.head}:refs/heads/${input.branch}`,
        ],
        cwd: input.repositoryRoot,
        env: {
          ...process.env,
          AUBTOWN_GITHUB_TOKEN: input.token,
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
        },
        timeoutMs: 5 * 60 * 1_000,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #line(
    executable: string,
    root: string,
    args: readonly string[],
  ): Promise<string> {
    return (
      await this.runner.run({
        executable,
        args,
        cwd: root,
      })
    ).stdout.trim();
  }
}

export class OctokitDraftPullRequestClient implements DraftPullRequestClient {
  constructor(private readonly octokit: Octokit) {}

  async readBranchHead(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const response = await this.octokit.rest.git.getRef({
        owner,
        repo: repository,
        ref: `heads/${branch}`,
      });
      return response.data.object.sha;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        (error as { readonly status?: number }).status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async findOpenByBranch(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<readonly DraftPullRequestSnapshot[]> {
    const responses = await this.octokit.paginate(
      this.octokit.rest.pulls.list,
      {
        owner,
        repo: repository,
        state: "open",
        head: `${owner}:${branch}`,
        per_page: 100,
      },
    );
    return responses.map(snapshot);
  }

  async createDraft(input: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<DraftPullRequestSnapshot> {
    const response = await this.octokit.rest.pulls.create({
      owner: input.owner,
      repo: input.repository,
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: true,
    });
    return snapshot(response.data);
  }

  async updateDraft(input: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
  }): Promise<DraftPullRequestSnapshot> {
    const response = await this.octokit.rest.pulls.update({
      owner: input.owner,
      repo: input.repository,
      pull_number: input.number,
      title: input.title,
      body: input.body,
    });
    return snapshot(response.data);
  }
}

export class GitHubDraftPublisher {
  constructor(
    private readonly broker: Pick<GitHubAppBroker, "mintDraftPublisher">,
    private readonly inspector: WorkProductStateInspector,
    private readonly branches: GitBranchPublisher,
    private readonly clientFactory: (
      token: InstallationTokenReceipt,
    ) => DraftPullRequestClient = (token) =>
      new OctokitDraftPullRequestClient(new Octokit({ auth: token.token })),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(plan: PublicationPlan): Promise<DraftPublicationReceipt> {
    const admitted = assertExecutablePlan(plan);
    const [owner, repository] = admitted.repository.split("/") as [string, string];
    const workProduct = workProductIdentitySchema.parse(admitted.workProduct);
    if (
      workProduct.repository.owner !== owner ||
      workProduct.repository.name !== repository ||
      workProduct.branch !== admitted.branch ||
      workProduct.head !== admitted.head
    ) {
      throw new Error("Draft publication plan changes its work-product identity.");
    }
    await assertExact(this.inspector, workProduct);
    const token = await this.broker.mintDraftPublisher({
      repository: admitted.repository,
      plan,
    });
    const client = this.clientFactory(token);
    const existing = await client.findOpenByBranch(owner, repository, admitted.branch);
    if (existing.length > 1) {
      throw new Error("Draft branch has multiple open pull requests.");
    }
    const pullRequest = existing[0];
    assertPullRequestBeforePush(admitted, pullRequest);
    const remoteHead = await client.readBranchHead(owner, repository, admitted.branch);
    if (remoteHead !== admitted.head) {
      const expected = admitted.expectedRemoteHead ?? null;
      if (remoteHead !== expected) {
        throw new Error("Draft branch changed after publication planning.");
      }
      await this.branches.push({
        repositoryRoot: workProduct.worktree,
        repository: admitted.repository,
        branch: admitted.branch,
        head: admitted.head,
        ...(remoteHead === null ? {} : { expectedRemoteHead: remoteHead }),
        token: token.token,
      });
    }
    await assertExact(this.inspector, workProduct);
    if (
      (await client.readBranchHead(owner, repository, admitted.branch)) !==
      admitted.head
    ) {
      throw new Error("Draft branch does not contain the exact admitted head.");
    }
    const published =
      pullRequest === undefined
        ? await client.createDraft({
            owner,
            repository,
            branch: admitted.branch,
            base: workProduct.repository.defaultBranch,
            title: admitted.title,
            body: admitted.body,
          })
        : admitted.action === "update-draft"
          ? await client.updateDraft({
              owner,
              repository,
              number: pullRequest.number,
              title: admitted.title,
              body: admitted.body,
            })
          : pullRequest;
    assertPublished(admitted, workProduct.repository.defaultBranch, published);
    return {
      schemaVersion: 1,
      repository: admitted.repository,
      checkpointReference: workProduct.checkpointReference,
      branch: admitted.branch,
      head: admitted.head,
      pullRequestNumber: published.number,
      pullRequestUrl: published.url,
      draft: true,
      publishedAt: this.now().toISOString(),
      tokenExpiresAt: token.expiresAt,
    };
  }
}

type ExecutablePublicationPlan = PublicationPlan & {
  readonly allowed: true;
  readonly action: "create-draft" | "update-draft";
  readonly repository: string;
  readonly title: string;
  readonly branch: string;
  readonly head: string;
  readonly body: string;
  readonly workProduct: NonNullable<PublicationPlan["workProduct"]>;
};

function assertExecutablePlan(plan: PublicationPlan): ExecutablePublicationPlan {
  if (
    !plan.allowed ||
    (plan.action !== "create-draft" && plan.action !== "update-draft") ||
    plan.repository === undefined ||
    !REPOSITORY.test(plan.repository) ||
    plan.title === undefined ||
    plan.branch === undefined ||
    plan.head === undefined ||
    !GIT_SHA.test(plan.head) ||
    plan.body === undefined ||
    !plan.body.startsWith("(AI Generated).\n\n") ||
    plan.workProduct === undefined
  ) {
    throw new Error("Draft publication requires one complete admitted plan.");
  }
  if (
    plan.reasons.length !== 0 ||
    !CONVENTIONAL_TITLE.test(plan.title) ||
    FORBIDDEN_AUTHORSHIP.test(plan.title) ||
    FORBIDDEN_AUTHORSHIP.test(plan.branch)
  ) {
    throw new Error("Draft publication plan violates title or branch policy.");
  }
  if (
    plan.action === "update-draft" &&
    (plan.pullRequestNumber === undefined || plan.expectedRemoteHead === undefined)
  ) {
    throw new Error("Draft update plan lacks its observed pull request identity.");
  }
  return plan as ExecutablePublicationPlan;
}

function assertPullRequestBeforePush(
  plan: ExecutablePublicationPlan,
  pullRequest: DraftPullRequestSnapshot | undefined,
): void {
  if (pullRequest === undefined) {
    if (plan.action === "update-draft") {
      throw new Error("Planned draft pull request no longer exists.");
    }
    return;
  }
  if (
    pullRequest.state !== "open" ||
    !pullRequest.draft ||
    pullRequest.branch !== plan.branch ||
    (plan.action === "update-draft" &&
      pullRequest.number !== plan.pullRequestNumber) ||
    (plan.action === "create-draft" &&
      (pullRequest.head !== plan.head ||
        pullRequest.title !== plan.title ||
        pullRequest.body !== plan.body))
  ) {
    throw new Error("Open pull request does not match the admitted draft plan.");
  }
}

function assertPublished(
  plan: ExecutablePublicationPlan,
  base: string,
  pullRequest: DraftPullRequestSnapshot,
): void {
  if (
    pullRequest.state !== "open" ||
    !pullRequest.draft ||
    pullRequest.branch !== plan.branch ||
    pullRequest.head !== plan.head ||
    pullRequest.base !== base ||
    pullRequest.title !== plan.title ||
    pullRequest.body !== plan.body
  ) {
    throw new Error("GitHub did not return the exact admitted draft pull request.");
  }
}

async function assertExact(
  inspector: WorkProductStateInspector,
  workProduct: NonNullable<PublicationPlan["workProduct"]>,
): Promise<void> {
  const state = await inspector.inspect(workProduct);
  if (
    state.head !== workProduct.head ||
    state.patchDigest !== workProduct.patchDigest
  ) {
    throw new Error("Worktree no longer matches the admitted publication plan.");
  }
}

function snapshot(input: {
  readonly number: number;
  readonly html_url: string;
  readonly state: string;
  readonly draft?: boolean | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
  readonly title: string;
  readonly body?: string | null;
}): DraftPullRequestSnapshot {
  return {
    number: input.number,
    url: input.html_url,
    state: input.state === "open" ? "open" : "closed",
    draft: input.draft === true,
    branch: input.head.ref,
    head: input.head.sha,
    base: input.base.ref,
    title: input.title,
    body: input.body ?? "",
  };
}
