import { z } from "zod";
import type {
  DispatchClaim,
  QualificationReport,
} from "../domain/types.js";
import { buildWorkerPrompt } from "../policy/prompt.js";

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

const claimSchema: z.ZodType<DispatchClaim> = z.object({
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().startsWith("/"),
  conflictDomains: z.array(z.string().min(1)).min(1),
  claimedAt: z.iso.datetime(),
});

export const qualificationReportSchema: z.ZodType<QualificationReport> = z.object({
  repository: repositorySchema,
  issue: z.object({
    number: z.number().int().positive(),
    url: z.url(),
    title: z.string().min(1),
    body: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    state: z.enum(["open", "closed"]),
    updatedAt: z.iso.datetime(),
  }),
  evidence: z.object({
    rootCause: z.string().min(1).optional(),
    evidence: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
    validation: z.array(z.string().min(1)).optional(),
    dependencies: z.array(z.number().int().positive()).optional(),
    ownedPaths: z.array(z.string().min(1)).optional(),
    logicalLocks: z.array(z.string().min(1)).optional(),
    hostLane: z.enum(["linux", "macos"]).optional(),
    lane: z.enum([
      "runtime-neutral",
      "behavioral",
      "provider-visible",
      "integration",
      "release",
      "macos",
      "sensitive",
    ]).optional(),
    providerNames: z.array(z.string().min(1)).optional(),
    requiresOwnerReview: z.boolean().optional(),
    behavioral: z.boolean().optional(),
    releaseOrMigrationRisk: z.boolean().optional(),
    duplicateOf: z.number().int().positive().optional(),
  }),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      passed: z.boolean(),
      blocking: z.boolean(),
      explanation: z.string(),
    }),
  ),
  eligible: z.boolean(),
  priorityScore: z.number(),
  conflictDomains: z.array(z.string().min(1)).min(1),
  hostLane: z.enum(["linux", "macos"]),
  workLane: z.enum([
    "runtime-neutral",
    "behavioral",
    "provider-visible",
    "integration",
    "release",
    "macos",
    "sensitive",
  ]),
});

export const executorStartCommandSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.uuid(),
  action: z.literal("start"),
  claim: claimSchema,
  qualification: qualificationReportSchema,
  authorityTaskId: z.string().min(1),
  accountId: z.string().min(1),
  driverId: z.string().min(1),
  prompt: z.string().min(1).max(256 * 1_024),
  repositoryRoot: z.string().startsWith("/"),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type ExecutorStartCommand = z.infer<typeof executorStartCommandSchema>;

const executorReceiptIdentitySchema = z.object({
  commandId: z.uuid(),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  observedAt: z.iso.datetime(),
});

export const executorCommandReceiptSchema = z.discriminatedUnion("stage", [
  executorReceiptIdentitySchema.extend({
    stage: z.literal("started"),
  }),
  executorReceiptIdentitySchema.extend({
    stage: z.enum(["completed", "interrupted", "failed"]),
    checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export type ExecutorCommandReceipt = z.infer<
  typeof executorCommandReceiptSchema
>;

export type ExecutorCommandReportInput =
  ExecutorCommandReceipt extends infer Receipt
    ? Receipt extends ExecutorCommandReceipt
      ? Omit<Receipt, "observedAt">
      : never
    : never;

export const executorReconcileRequestSchema = executorReceiptIdentitySchema.pick({
  commandId: true,
  claimId: true,
  custodyEpoch: true,
  accountId: true,
  threadId: true,
  turnId: true,
});

export type ExecutorReconcileRequest = z.infer<
  typeof executorReconcileRequestSchema
>;

export function createExecutorStartCommand(input: {
  readonly commandId: string;
  readonly claim: DispatchClaim;
  readonly qualification: QualificationReport;
  readonly authorityTaskId: string;
  readonly accountId: string;
  readonly driverId: string;
  readonly baseHead: string;
  readonly issuedAt: string;
}): ExecutorStartCommand {
  const issuedAt = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    throw new Error("Executor start command issue time is invalid.");
  }
  return assertExecutorStartCommand({
    schemaVersion: 1,
    commandId: input.commandId,
    action: "start",
    claim: input.claim,
    qualification: input.qualification,
    authorityTaskId: input.authorityTaskId,
    accountId: input.accountId,
    driverId: input.driverId,
    prompt: buildWorkerPrompt({
      qualification: input.qualification,
      claim: input.claim,
      authorityTaskId: input.authorityTaskId,
    }),
    repositoryRoot: input.claim.worktree,
    baseHead: input.baseHead,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 5 * 60 * 1_000).toISOString(),
  });
}

export function assertExecutorStartCommand(
  value: unknown,
  targetHostId?: string,
): ExecutorStartCommand {
  const command = executorStartCommandSchema.parse(value);
  const issuedAt = Date.parse(command.issuedAt);
  const expiresAt = Date.parse(command.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 * 1_000) {
    throw new Error("Executor start command lifetime must be at most five minutes.");
  }
  if (targetHostId !== undefined && command.claim.hostId !== targetHostId) {
    throw new Error("Executor start command targets another host.");
  }
  if (!command.qualification.eligible) {
    throw new Error("Executor start command contains an ineligible qualification.");
  }
  if (
    command.claim.repository.owner !== command.qualification.repository.owner ||
    command.claim.repository.name !== command.qualification.repository.name ||
    command.claim.repository.defaultBranch !==
      command.qualification.repository.defaultBranch ||
    command.claim.issueNumber !== command.qualification.issue.number
  ) {
    throw new Error("Executor start command claim does not match qualification.");
  }
  if (command.repositoryRoot !== command.claim.worktree) {
    throw new Error("Executor start command root does not match claim worktree.");
  }
  const claimDomains = [...command.claim.conflictDomains].sort();
  const qualifiedDomains = [...command.qualification.conflictDomains].sort();
  if (JSON.stringify(claimDomains) !== JSON.stringify(qualifiedDomains)) {
    throw new Error("Executor start command changes qualified conflict domains.");
  }
  const expectedPrompt = buildWorkerPrompt({
    qualification: command.qualification,
    claim: command.claim,
    authorityTaskId: command.authorityTaskId,
  });
  if (command.prompt !== expectedPrompt) {
    throw new Error("Executor start command prompt does not match governed input.");
  }
  return command;
}

export function assertCommandMatchesCurrentClaim(input: {
  readonly command: ExecutorStartCommand;
  readonly currentClaim: DispatchClaim;
  readonly requestingHostId: string;
  readonly accountId: string;
  readonly driverId: string;
  readonly hostLane: "linux" | "macos";
  readonly now: string;
  readonly enforceStartWindow?: boolean;
}): void {
  const command = assertExecutorStartCommand(input.command, input.requestingHostId);
  const claim = input.currentClaim;
  if (
    claim.repository.owner !== command.claim.repository.owner ||
    claim.repository.name !== command.claim.repository.name ||
    claim.repository.defaultBranch !== command.claim.repository.defaultBranch ||
    claim.issueNumber !== command.claim.issueNumber ||
    claim.claimId !== command.claim.claimId ||
    claim.custodyEpoch !== command.claim.custodyEpoch ||
    claim.hostId !== command.claim.hostId ||
    claim.workerId !== command.claim.workerId ||
    claim.branch !== command.claim.branch ||
    claim.worktree !== command.claim.worktree ||
    claim.claimedAt !== command.claim.claimedAt ||
    JSON.stringify([...claim.conflictDomains].sort()) !==
      JSON.stringify([...command.claim.conflictDomains].sort())
  ) {
    throw new Error("Executor start command does not match current claim custody.");
  }
  if (command.accountId !== input.accountId) {
    throw new Error("Executor start command targets another execution account.");
  }
  if (command.driverId !== input.driverId) {
    throw new Error("Executor start command targets another worker driver.");
  }
  if (command.qualification.hostLane === "macos" && input.hostLane !== "macos") {
    throw new Error("Executor host cannot satisfy the command's macOS lane.");
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    throw new Error("Executor command validation time is invalid.");
  }
  if (
    input.enforceStartWindow !== false &&
    now < Date.parse(command.issuedAt) - 120_000
  ) {
    throw new Error("Executor start command issue time is invalid.");
  }
  if (input.enforceStartWindow !== false && now >= Date.parse(command.expiresAt)) {
    throw new Error("Executor start command has expired.");
  }
}
