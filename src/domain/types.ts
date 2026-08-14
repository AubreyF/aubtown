export const FACTORY_LABELS = [
  "factory:ready",
  "factory:running",
  "factory:blocked",
  "factory:human-review",
] as const;

export type FactoryLabel = (typeof FACTORY_LABELS)[number];

export type WorkLane =
  | "runtime-neutral"
  | "behavioral"
  | "provider-visible"
  | "integration"
  | "release"
  | "macos"
  | "sensitive";

export type HostLane = "linux" | "macos";

export type PublicationCeiling = "none" | "status-only" | "draft-pr";

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export interface IssueRecord {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly state: "open" | "closed";
  readonly updatedAt: string;
}

export interface IssueEvidence {
  readonly rootCause?: string | undefined;
  readonly evidence?: string | undefined;
  readonly scope?: string | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly validation?: readonly string[] | undefined;
  readonly dependencies?: readonly number[] | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  readonly logicalLocks?: readonly string[] | undefined;
  readonly hostLane?: HostLane | undefined;
  readonly lane?: WorkLane | undefined;
  readonly providerNames?: readonly string[] | undefined;
  readonly requiresOwnerReview?: boolean | undefined;
  readonly behavioral?: boolean | undefined;
  readonly releaseOrMigrationRisk?: boolean | undefined;
  readonly duplicateOf?: number | undefined;
}

export interface AuthorityTask {
  readonly id: string;
  readonly revision: number;
  readonly state: string;
  readonly githubIssue: {
    readonly number: number;
    readonly url: string;
  };
  readonly executionAuthority: string;
  readonly providerAuthority: string;
  readonly behavioral: boolean;
  readonly estimatedMinutes: number;
}

export interface QualificationCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly blocking: boolean;
  readonly explanation: string;
}

export interface QualificationReport {
  readonly repository: RepositoryRef;
  readonly issue: IssueRecord;
  readonly evidence: IssueEvidence;
  readonly checks: readonly QualificationCheck[];
  readonly eligible: boolean;
  readonly priorityScore: number;
  readonly conflictDomains: readonly string[];
  readonly hostLane: HostLane;
  readonly workLane: WorkLane;
}

export interface DispatchClaim {
  readonly repository: RepositoryRef;
  readonly issueNumber: number;
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly hostId: string;
  readonly workerId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly conflictDomains: readonly string[];
  readonly claimedAt: string;
}

export interface ClaimTransferRequest {
  readonly claimId: string;
  readonly priorEpoch: number;
  readonly nextEpoch: number;
  readonly destinationHostId: string;
  readonly destinationWorkerId: string;
  readonly destinationWorktree: string;
  readonly transferredAt: string;
}

export interface HostRecord {
  readonly id: string;
  readonly lane: HostLane;
  readonly online: boolean;
  readonly lastHeartbeatAt: string;
  readonly activeClaims: readonly string[];
  readonly accountIds: readonly string[];
}

export interface ActiveDispatch {
  readonly claim: DispatchClaim;
  readonly workLane: WorkLane;
  readonly hostLane: HostLane;
}

export interface HostRoute {
  readonly host: HostRecord;
  readonly account: ExecutionAccount;
  readonly quotaAction: "admit" | "throttle";
}

export interface UsageWindow {
  readonly usedPercent: number;
  readonly windowDurationMinutes: number;
  readonly resetsAt: string;
}

export interface AccountUsageSnapshot {
  readonly accountId: string;
  readonly observedAt: string;
  readonly primary: UsageWindow;
  readonly dailyBaseline: {
    readonly observedAt: string;
    readonly usedPercent: number;
    readonly resetsAt: string;
  };
  readonly dailyConsumption: {
    readonly day: string;
    readonly baselineLifetimeTokens: number;
    readonly observedLifetimeTokens: number;
    readonly grossUsedPercent: number;
    readonly meterState: "coherent" | "diverged";
  };
  readonly activeTurnIds: readonly string[];
}

export interface RawAccountUsageObservation {
  readonly accountId: string;
  readonly observedAt: string;
  readonly primary: UsageWindow;
  readonly lifetimeTokens: number;
  readonly activeTurnIds: readonly string[];
}

export interface ExecutionAccount {
  readonly id: string;
  readonly driverId: string;
  readonly enabled: boolean;
  readonly hostIds: readonly string[];
  readonly usage: AccountUsageSnapshot;
}

export interface CustodyCheckpoint {
  readonly schemaVersion: 2;
  readonly repository: RepositoryRef;
  readonly issueNumber: number;
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly sourceHostId: string;
  readonly repositoryHead: string;
  readonly baseHead: string;
  readonly patchDigest: string;
  readonly includedUntrackedPaths: readonly string[];
  readonly validationReceipts: readonly string[];
  readonly createdAt: string;
}

export interface ReconciliationIssueState {
  readonly number: number;
  readonly url: string;
  readonly open: boolean;
  readonly labels: readonly string[];
  readonly openPullRequestBranches: readonly string[];
}

export interface ReconciliationWorkspaceState {
  readonly hostId: string;
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly branch: string;
  readonly worktree: string;
  readonly exists: boolean;
}
