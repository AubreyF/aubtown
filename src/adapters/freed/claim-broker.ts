import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../command-runner.js";
import type { ExecutionAdmission } from "../execution-admission.js";
import { executionAdmissionSchema } from "../execution-admission.js";
import { canonicalJson } from "../../security/canonical-json.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const DEFAULT_READ_BROKER_TIMEOUT_MS = 120_000;
const DEFAULT_MUTATION_BROKER_TIMEOUT_MS = 13 * 60_000;
const releaseReasonSchema = z.enum([
  "prelaunch-denied",
  "worker-completed",
  "worker-failed",
  "worker-interrupted",
  "reconciled-unlaunched",
]);

const issueIdentitySchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
}).strict();

const successfulControlEnvelope = {
  ok: z.literal(true),
  schemaVersion: z.literal(1),
} as const;

const brokerClaimSchema = z.object({
  claimId: z.string().min(1),
  githubIssue: issueIdentitySchema,
  custodyEpoch: z.number().int().positive(),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  conflictDomains: z.array(z.string().min(1)),
  conflictDomainDigest: digestSchema,
  claimedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  accountId: z.string().min(1),
  driverId: z.string().min(1),
  target: z.enum(["shared", "desktop", "pwa", "website"]),
  workLane: z.enum([
    "runtime-neutral",
    "behavioral",
    "provider-visible",
    "integration",
    "release",
    "macos",
    "sensitive",
  ]),
  publicationCeiling: z.literal("draft-pr"),
  executionStage: z.enum(["claimed", "running"]),
  transferredAt: z.iso.datetime().optional(),
  checkpointReference: digestSchema.optional(),
}).strict();

export type FreedBrokerClaim = z.infer<typeof brokerClaimSchema>;

const acquireRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  taskId: z.string().min(1),
  expectedTaskRevision: z.number().int().positive(),
  bindingDigest: digestSchema,
  claim: brokerClaimSchema.omit({
    heartbeatAt: true,
    executionStage: true,
    transferredAt: true,
    checkpointReference: true,
  }),
  requestedAt: z.iso.datetime(),
}).strict();

export type FreedClaimAcquireRequest = z.infer<typeof acquireRequestSchema>;

const acquireOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-acquire"),
  result: z.object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    authorityClaimId: z.string().min(1),
    custodyEpoch: z.number().int().positive(),
    bindingDigest: digestSchema,
    conflictDomainDigest: digestSchema,
    admission: executionAdmissionSchema,
  }).strict(),
}).strict();

export type FreedClaimAcquireReceipt = z.infer<typeof acquireOutputSchema>["result"];

const showRequestSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
}).strict();

export type FreedClaimShowRequest = z.infer<typeof showRequestSchema>;

const showOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-show"),
  result: z.object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    bindingDigest: digestSchema.nullable(),
    claim: brokerClaimSchema.nullable(),
  }).strict(),
}).strict();

export type FreedClaimShowReceipt = z.infer<typeof showOutputSchema>["result"];

const listRequestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();

export type FreedClaimListRequest = z.infer<typeof listRequestSchema>;

const listOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-list"),
  result: z.object({
    schemaVersion: z.literal(1),
    claims: z.array(z.object({
      taskId: z.string().min(1),
      taskRevision: z.number().int().positive(),
      bindingDigest: digestSchema,
      claim: brokerClaimSchema,
    }).strict()),
  }).strict(),
}).strict();

export type FreedClaimListReceipt = z.infer<typeof listOutputSchema>["result"];

const heartbeatRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  authorityClaimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  bindingDigest: digestSchema,
  heartbeatAt: z.iso.datetime(),
  executionStage: z.literal("running"),
}).strict();

export type FreedClaimHeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

const heartbeatOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-heartbeat"),
  result: heartbeatRequestSchema,
}).strict();

export type FreedClaimHeartbeatReceipt = z.infer<
  typeof heartbeatOutputSchema
>["result"];

const transferRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  authorityClaimId: z.string().min(1),
  bindingDigest: digestSchema,
  priorEpoch: z.number().int().positive(),
  nextEpoch: z.number().int().positive(),
  destinationHostId: z.string().min(1),
  destinationWorkerId: z.string().min(1),
  destinationWorktree: z.string().min(1),
  checkpointReference: digestSchema,
  transferredAt: z.iso.datetime(),
}).strict();

export type FreedClaimTransferRequest = z.infer<typeof transferRequestSchema>;

const transferOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-transfer"),
  result: transferRequestSchema,
}).strict();

export type FreedClaimTransferReceipt = z.infer<
  typeof transferOutputSchema
>["result"];

export const freedClaimReleaseRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  taskId: z.string().min(1),
  expectedTaskRevision: z.number().int().positive(),
  authorityClaimId: z.string().min(1),
  bindingDigest: digestSchema,
  expectedHeartbeatAt: z.iso.datetime(),
  reason: releaseReasonSchema,
  releasedAt: z.iso.datetime(),
  custodyEpoch: z.number().int().positive().optional(),
}).strict();

export type FreedClaimReleaseRequest = z.infer<
  typeof freedClaimReleaseRequestSchema
>;

const releaseOutputSchema = z.object({
  ...successfulControlEnvelope,
  action: z.literal("task.claim-release"),
  result: z.object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    authorityClaimId: z.string().min(1),
    bindingDigest: digestSchema,
    expectedHeartbeatAt: z.iso.datetime(),
    reason: releaseReasonSchema,
    releasedAt: z.iso.datetime(),
    custodyEpoch: z.number().int().positive().optional(),
  }).strict(),
}).strict();

export const freedClaimReleaseReceiptSchema = releaseOutputSchema.shape.result;

export type FreedClaimReleaseReceipt = z.infer<
  typeof releaseOutputSchema
>["result"];

export interface FreedClaimBrokerOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

function canonicalJsonText(value: unknown): string {
  return Buffer.from(canonicalJson(value)).toString("utf8");
}

function assertAbsoluteExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) {
    throw new Error("Freed coordinator broker path must be absolute.");
  }
}

function hasStructuredFreedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return false;
  }
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string") {
    return false;
  }
  for (const line of stderr.trim().split("\n").reverse()) {
    try {
      z.object({
        schemaVersion: z.literal(1),
        error: z.object({ code: z.string().min(1) }).passthrough(),
      }).passthrough().parse(JSON.parse(line));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export class FreedClaimBrokerClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: FreedClaimBrokerOptions,
  ) {
    assertAbsoluteExecutable(options.executable);
    if (!path.isAbsolute(options.cwd)) {
      throw new Error("Freed coordinator broker working directory must be absolute.");
    }
  }

  async acquire(request: FreedClaimAcquireRequest): Promise<FreedClaimAcquireReceipt> {
    const payload = acquireRequestSchema.parse(request);
    const output = await this.#run("claim-acquire", payload);
    return acquireOutputSchema.parse(JSON.parse(output)).result;
  }

  async show(request: FreedClaimShowRequest): Promise<FreedClaimShowReceipt> {
    const payload = showRequestSchema.parse(request);
    const output = await this.#run("claim-show", payload, false);
    return showOutputSchema.parse(JSON.parse(output)).result;
  }

  async list(request: FreedClaimListRequest): Promise<FreedClaimListReceipt> {
    const payload = listRequestSchema.parse(request);
    const output = await this.#run("claim-list", payload, false);
    const result = listOutputSchema.parse(JSON.parse(output)).result;
    const taskIds = new Set<string>();
    const claimIds = new Set<string>();
    const issueNumbers = new Set<number>();
    const branches = new Set<string>();
    const worktrees = new Set<string>();
    for (const entry of result.claims) {
      if (
        taskIds.has(entry.taskId) ||
        claimIds.has(entry.claim.claimId) ||
        issueNumbers.has(entry.claim.githubIssue.number) ||
        branches.has(entry.claim.branch) ||
        worktrees.has(entry.claim.worktree)
      ) {
        throw new Error(
          "Freed claim list contains duplicate task, claim, issue, branch, or worktree identity.",
        );
      }
      taskIds.add(entry.taskId);
      claimIds.add(entry.claim.claimId);
      issueNumbers.add(entry.claim.githubIssue.number);
      branches.add(entry.claim.branch);
      worktrees.add(entry.claim.worktree);
    }
    return {
      ...result,
      claims: [...result.claims].sort((left, right) =>
        left.taskId.localeCompare(right.taskId),
      ),
    };
  }

  async heartbeat(
    request: FreedClaimHeartbeatRequest,
  ): Promise<FreedClaimHeartbeatReceipt> {
    const payload = heartbeatRequestSchema.parse(request);
    const output = await this.#run("claim-heartbeat", payload);
    return heartbeatOutputSchema.parse(JSON.parse(output)).result;
  }

  async transfer(
    request: FreedClaimTransferRequest,
  ): Promise<FreedClaimTransferReceipt> {
    const payload = transferRequestSchema.parse(request);
    if (payload.nextEpoch !== payload.priorEpoch + 1) {
      throw new Error("Freed claim transfer must advance exactly one custody epoch.");
    }
    const output = await this.#run("claim-transfer", payload);
    return transferOutputSchema.parse(JSON.parse(output)).result;
  }

  async release(
    request: FreedClaimReleaseRequest,
  ): Promise<FreedClaimReleaseReceipt> {
    const payload = freedClaimReleaseRequestSchema.parse(request);
    const output = await this.#run("claim-release", payload);
    return releaseOutputSchema.parse(JSON.parse(output)).result;
  }

  async #run(
    operation:
      | "claim-acquire"
      | "claim-list"
      | "claim-show"
      | "claim-heartbeat"
      | "claim-transfer"
      | "claim-release",
    request: unknown,
    retry = true,
  ): Promise<string> {
    const command = {
      executable: this.options.executable,
      args: [
        ...(this.options.args ?? []),
        "task",
        operation,
        "--request-json",
        canonicalJsonText(request),
      ],
      cwd: this.options.cwd,
      env: {},
      timeoutMs:
        this.options.timeoutMs ??
        (retry
          ? DEFAULT_MUTATION_BROKER_TIMEOUT_MS
          : DEFAULT_READ_BROKER_TIMEOUT_MS),
      maxBufferBytes: 1024 * 1024,
    } as const;
    try {
      return (await this.runner.run(command)).stdout;
    } catch (error) {
      if (!retry || hasStructuredFreedError(error)) {
        throw error;
      }
      return (await this.runner.run(command)).stdout;
    }
  }
}

export function admissionFromAcquire(
  receipt: FreedClaimAcquireReceipt,
): ExecutionAdmission {
  return receipt.admission;
}
