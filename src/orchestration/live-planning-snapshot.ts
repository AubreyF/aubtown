import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import type {
  AuthorityBridge,
  AuthorityInspection,
} from "../adapters/authority.js";
import type {
  DispatchClaim,
  IssueRecord,
  QualificationReport,
  RepositoryRef,
  WorkLane,
} from "../domain/types.js";
import type { HostObservationSnapshot } from "../gateway/host-observation-journal.js";
import { parseDebtIssueBody } from "../adapters/github/issue-parser.js";
import { qualifyIssue } from "../policy/admission.js";
import { decideQuota } from "../policy/quota.js";

const GIT_SHA = /^[0-9a-f]{40}$/u;
const HOST_HEARTBEAT_MAX_AGE_SECONDS = 120;

export interface PlanningPullRequest {
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
}

export interface GitHubPlanningObservation {
  readonly observedAt: string;
  readonly issue: IssueRecord;
  readonly baseHead: string;
  readonly openPullRequests: readonly PlanningPullRequest[];
}

export interface LocalWorktreeObservation {
  readonly worktree: string;
  readonly head: string;
  readonly branch: string | null;
}

export interface LocalRepositoryObservation {
  readonly observedAt: string;
  readonly remoteBaseHead: string | null;
  readonly refs: Readonly<Record<string, string>>;
  readonly worktrees: readonly LocalWorktreeObservation[];
}

export interface AuthorityPlanningObservation {
  readonly observedAt: string;
  readonly inspection: AuthorityInspection;
  readonly activeClaims: readonly DispatchClaim[];
  readonly activeLanes: readonly WorkLane[];
  readonly claimEvidenceComplete: boolean;
  readonly claimEvidenceReason: string;
}

export interface GitHubPlanningReader {
  read(input: {
    readonly repository: RepositoryRef;
    readonly issueNumber: number;
    readonly now: string;
  }): Promise<GitHubPlanningObservation>;
}

export interface AuthorityPlanningReader {
  read(input: {
    readonly qualification: QualificationReport;
    readonly now: string;
  }): Promise<AuthorityPlanningObservation>;
}

export interface HostPlanningReader {
  snapshot(): Promise<HostObservationSnapshot>;
}

export interface LocalRepositoryPlanningReader {
  read(input: {
    readonly repositoryRoot: string;
    readonly defaultBranch: string;
    readonly now: string;
  }): Promise<LocalRepositoryObservation>;
}

export type PlanningSourceResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "blocked"; readonly reason: string };

export interface LivePlanningSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly repository: RepositoryRef;
  readonly issueNumber: number;
  readonly github: PlanningSourceResult<GitHubPlanningObservation>;
  readonly authority: PlanningSourceResult<AuthorityPlanningObservation>;
  readonly hosts: PlanningSourceResult<HostObservationSnapshot>;
  readonly localRepository: PlanningSourceResult<LocalRepositoryObservation>;
  readonly qualification?: QualificationReport;
  readonly planningSafe: boolean;
  readonly blockers: readonly string[];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(operation: () => Promise<T>): Promise<PlanningSourceResult<T>> {
  try {
    return { status: "ok", value: await operation() };
  } catch (error) {
    return { status: "blocked", reason: reason(error) };
  }
}

export class BridgePlanningAuthorityReader implements AuthorityPlanningReader {
  constructor(private readonly bridge: AuthorityBridge) {}

  async read(input: {
    readonly qualification: QualificationReport;
    readonly now: string;
  }): Promise<AuthorityPlanningObservation> {
    return {
      observedAt: input.now,
      inspection: await this.bridge.inspect(input.qualification),
      activeClaims: [],
      activeLanes: [],
      claimEvidenceComplete: false,
      claimEvidenceReason: "Freed task-scoped claim listing is not installed.",
    };
  }
}

export class GitLocalRepositoryPlanningReader
  implements LocalRepositoryPlanningReader
{
  constructor(
    private readonly runner: CommandRunner,
    private readonly gitExecutable: string,
  ) {}

  async read(input: {
    readonly repositoryRoot: string;
    readonly defaultBranch: string;
    readonly now: string;
  }): Promise<LocalRepositoryObservation> {
    if (!path.isAbsolute(input.repositoryRoot) || !path.isAbsolute(this.gitExecutable)) {
      throw new Error("Planning Git repository and executable paths must be absolute.");
    }
    const [worktreeOutput, refOutput] = await Promise.all([
      this.runner.run({
        executable: this.gitExecutable,
        args: ["worktree", "list", "--porcelain"],
        cwd: input.repositoryRoot,
        env: {},
      }),
      this.runner.run({
        executable: this.gitExecutable,
        args: [
          "for-each-ref",
          "--format=%(refname:short)%00%(objectname)",
          "refs/heads",
          "refs/remotes/origin",
        ],
        cwd: input.repositoryRoot,
        env: {},
      }),
    ]);
    const refs: Record<string, string> = {};
    for (const line of refOutput.stdout.split(/\r?\n/u).filter(Boolean)) {
      const [name, head, extra] = line.split("\0");
      if (name === undefined || head === undefined || extra !== undefined || !GIT_SHA.test(head)) {
        throw new Error("Local Git ref observation is malformed.");
      }
      refs[name] = head;
    }
    return {
      observedAt: input.now,
      remoteBaseHead: refs[`origin/${input.defaultBranch}`] ?? null,
      refs: Object.fromEntries(
        Object.entries(refs).sort(([left], [right]) => left.localeCompare(right)),
      ),
      worktrees: parseWorktrees(worktreeOutput.stdout),
    };
  }
}

function parseWorktrees(output: string): readonly LocalWorktreeObservation[] {
  const records: LocalWorktreeObservation[] = [];
  for (const block of output.trim().split(/\r?\n\r?\n/u).filter(Boolean)) {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/u)) {
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      values.set(key, value);
    }
    const worktree = values.get("worktree");
    const head = values.get("HEAD");
    if (worktree === undefined || !path.isAbsolute(worktree) || head === undefined || !GIT_SHA.test(head)) {
      throw new Error("Local Git worktree observation is malformed.");
    }
    const branchRef = values.get("branch");
    records.push({
      worktree,
      head,
      branch:
        branchRef?.startsWith("refs/heads/") === true
          ? branchRef.slice("refs/heads/".length)
          : null,
    });
  }
  return records.sort((left, right) => left.worktree.localeCompare(right.worktree));
}

export class LivePlanningSnapshotCollector {
  constructor(
    private readonly github: GitHubPlanningReader,
    private readonly authority: AuthorityPlanningReader,
    private readonly hosts: HostPlanningReader,
    private readonly localRepository: LocalRepositoryPlanningReader,
  ) {}

  async collect(input: {
    readonly repository: RepositoryRef;
    readonly issueNumber: number;
    readonly repositoryRoot: string;
    readonly now: string;
  }): Promise<LivePlanningSnapshot> {
    const [github, hosts, localRepository] = await Promise.all([
      capture(async () =>
        await this.github.read({
          repository: input.repository,
          issueNumber: input.issueNumber,
          now: input.now,
        }),
      ),
      capture(async () => await this.hosts.snapshot()),
      capture(async () =>
        await this.localRepository.read({
          repositoryRoot: input.repositoryRoot,
          defaultBranch: input.repository.defaultBranch,
          now: input.now,
        }),
      ),
    ]);

    let authority: PlanningSourceResult<AuthorityPlanningObservation> = {
      status: "blocked",
      reason: "GitHub qualification is unavailable.",
    };
    let qualification: QualificationReport | undefined;
    if (github.status === "ok") {
      const evidence = parseDebtIssueBody(github.value.issue.body);
      const shadow = qualifyIssue({
        repository: input.repository,
        issue: github.value.issue,
        evidence,
        requireExecutionAuthority: false,
      });
      authority = await capture(async () =>
        await this.authority.read({ qualification: shadow, now: input.now }),
      );
      qualification = qualifyIssue({
        repository: input.repository,
        issue: github.value.issue,
        evidence,
        ...(authority.status === "ok" && authority.value.inspection.task !== undefined
          ? { authorityTask: authority.value.inspection.task }
          : {}),
      });
    }

    const blockers: string[] = [];
    for (const [name, source] of [
      ["github", github],
      ["authority", authority],
      ["hosts", hosts],
      ["local-repository", localRepository],
    ] as const) {
      if (source.status === "blocked") {
        blockers.push(`${name}:${source.reason}`);
      }
    }
    if (qualification !== undefined && !qualification.eligible) {
      blockers.push(
        ...qualification.checks
          .filter((check) => check.blocking && !check.passed)
          .map((check) => `qualification:${check.id}`),
      );
    }
    if (authority.status === "ok") {
      if (!authority.value.inspection.active) {
        blockers.push(`authority:${authority.value.inspection.reason}`);
      }
      if (!authority.value.claimEvidenceComplete) {
        blockers.push(`authority:${authority.value.claimEvidenceReason}`);
      }
      if (authority.value.activeClaims.length !== authority.value.activeLanes.length) {
        blockers.push("authority:active-claim-lane-mismatch");
      }
    }
    if (hosts.status === "ok" && hosts.value.observedAt === null) {
      blockers.push("hosts:no-authenticated-observations");
    }
    if (
      hosts.status === "ok" &&
      hosts.value.observedAt !== null &&
      qualification !== undefined
    ) {
      const nowMs = Date.parse(input.now);
      const compatibleHosts = hosts.value.hosts.filter((host) => {
        const ageSeconds = (nowMs - Date.parse(host.lastHeartbeatAt)) / 1_000;
        return (
          host.online &&
          host.lane === qualification.hostLane &&
          Number.isFinite(ageSeconds) &&
          ageSeconds >= 0 &&
          ageSeconds <= HOST_HEARTBEAT_MAX_AGE_SECONDS
        );
      });
      if (compatibleHosts.length === 0) {
        blockers.push("hosts:no-fresh-compatible-host");
      } else {
        const hasHeadroom = compatibleHosts.some((host) =>
          host.accountIds.some((accountId) => {
            const usage = hosts.value.usageByAccountId[accountId];
            if (usage === undefined) {
              return false;
            }
            try {
              const decision = decideQuota({ snapshot: usage, now: input.now });
              return decision.action === "admit" || decision.action === "throttle";
            } catch {
              return false;
            }
          }),
        );
        if (!hasHeadroom) {
          blockers.push("quota:no-compatible-account-headroom");
        }
      }
    }
    if (
      github.status === "ok" &&
      localRepository.status === "ok" &&
      localRepository.value.remoteBaseHead !== github.value.baseHead
    ) {
      blockers.push("local-repository:origin-base-does-not-match-github");
    }

    const uniqueBlockers = [...new Set(blockers)].sort();
    return {
      schemaVersion: 1,
      generatedAt: input.now,
      repository: input.repository,
      issueNumber: input.issueNumber,
      github,
      authority,
      hosts,
      localRepository,
      ...(qualification === undefined ? {} : { qualification }),
      planningSafe: uniqueBlockers.length === 0,
      blockers: uniqueBlockers,
    };
  }
}
