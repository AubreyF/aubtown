import { z } from "zod";
import { canonicalJson } from "../security/canonical-json.js";
import type { CustodyCheckpoint } from "../domain/types.js";
import type { ExecutorStartCommand } from "../execution/command.js";
import type { WorkerTurnHandle } from "../drivers/worker.js";

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

const turnIdentitySchema = z.object({
  driverId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});

export const workProductIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  hostId: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().startsWith("/"),
  commandId: z.uuid(),
  checkpointReference: digestSchema,
  baseHead: gitShaSchema,
  head: gitShaSchema,
  patchDigest: digestSchema,
  implementation: turnIdentitySchema,
});

export type WorkProductIdentity = z.infer<typeof workProductIdentitySchema>;

export function createWorkProductIdentity(input: {
  readonly command: ExecutorStartCommand;
  readonly checkpointReference: string;
  readonly checkpoint: CustodyCheckpoint;
  readonly implementation: WorkerTurnHandle;
}): WorkProductIdentity {
  const { claim } = input.command;
  const checkpoint = input.checkpoint;
  if (
    checkpoint.repository.owner !== claim.repository.owner ||
    checkpoint.repository.name !== claim.repository.name ||
    checkpoint.repository.defaultBranch !== claim.repository.defaultBranch ||
    checkpoint.issueNumber !== claim.issueNumber ||
    checkpoint.claimId !== claim.claimId ||
    checkpoint.custodyEpoch !== claim.custodyEpoch ||
    checkpoint.sourceHostId !== claim.hostId ||
    checkpoint.baseHead !== input.command.baseHead ||
    !checkpoint.validationReceipts.includes(
      `executor-command:${input.command.commandId}`,
    ) ||
    !checkpoint.validationReceipts.includes("worker-turn:completed")
  ) {
    throw new Error(
      "Completed executor command does not match its authenticated checkpoint.",
    );
  }
  return workProductIdentitySchema.parse({
    schemaVersion: 1,
    repository: claim.repository,
    issueNumber: claim.issueNumber,
    claimId: claim.claimId,
    custodyEpoch: claim.custodyEpoch,
    hostId: claim.hostId,
    branch: claim.branch,
    worktree: claim.worktree,
    commandId: input.command.commandId,
    checkpointReference: input.checkpointReference,
    baseHead: checkpoint.baseHead,
    head: checkpoint.repositoryHead,
    patchDigest: checkpoint.patchDigest,
    implementation: input.implementation,
  });
}

const validationCommandReceiptSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().startsWith("/"),
  exitCode: z.number().int(),
  outputDigest: digestSchema,
  durationMs: z.number().int().nonnegative(),
});

export const exactValidationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exact-validation"),
  workProduct: workProductIdentitySchema,
  passed: z.boolean(),
  commands: z.array(validationCommandReceiptSchema).min(1),
  completedAt: z.iso.datetime(),
  summary: z.string().min(1),
});

export type ExactValidationReceipt = z.infer<
  typeof exactValidationReceiptSchema
>;

const reviewFindingSchema = z.object({
  severity: z.enum(["blocker", "high", "medium", "low"]),
  title: z.string().min(1),
  body: z.string().min(1),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
});

export const independentReviewReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("independent-review"),
    workProduct: workProductIdentitySchema,
    reviewer: turnIdentitySchema,
    verdict: z.enum(["pass", "changes-requested", "blocked"]),
    findings: z.array(reviewFindingSchema),
    completedAt: z.iso.datetime(),
    summary: z.string().min(1),
  })
  .superRefine((receipt, context) => {
    if (
      receipt.reviewer.threadId ===
      receipt.workProduct.implementation.threadId
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "threadId"],
        message: "Independent review requires a fresh thread.",
      });
    }
    if (
      receipt.verdict === "pass" &&
      receipt.findings.some(
        (finding) =>
          finding.severity === "blocker" || finding.severity === "high",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "A passing review cannot contain blocker or high findings.",
      });
    }
  });

export type IndependentReviewReceipt = z.infer<
  typeof independentReviewReceiptSchema
>;

export interface HandoffAssessment {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJson(left)).equals(Buffer.from(canonicalJson(right)));
}

export function assessHandoff(input: {
  readonly workProduct: WorkProductIdentity;
  readonly validation: ExactValidationReceipt;
  readonly review: IndependentReviewReceipt;
}): HandoffAssessment {
  const workProduct = workProductIdentitySchema.parse(input.workProduct);
  const validation = exactValidationReceiptSchema.parse(input.validation);
  const review = independentReviewReceiptSchema.parse(input.review);
  const reasons: string[] = [];
  if (!sameCanonical(validation.workProduct, workProduct)) {
    reasons.push("validation-work-product-mismatch");
  }
  if (!validation.passed || validation.commands.some((command) => command.exitCode !== 0)) {
    reasons.push("validation-failed");
  }
  if (!sameCanonical(review.workProduct, workProduct)) {
    reasons.push("review-work-product-mismatch");
  }
  if (review.verdict !== "pass") {
    reasons.push("review-not-passed");
  }
  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
}
