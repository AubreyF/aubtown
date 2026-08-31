import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  freedClaimReleaseReceiptSchema,
  freedClaimReleaseRequestSchema,
  type FreedClaimReleaseReceipt,
  type FreedClaimReleaseRequest,
} from "../adapters/freed/claim-broker.js";
import {
  workProductIdentitySchema,
} from "../adjudication/receipts.js";
import {
  trustedAdjudicationResultSchema,
  type TrustedAdjudicationResult,
} from "../adjudication/trusted-runner.js";
import type { DispatchClaim } from "../domain/types.js";
import {
  projectionWriteReceiptSchema,
  type ProjectionWriteReceipt,
} from "../projection/github-writer.js";
import {
  buildStatusProjection,
  statusProjectionSchema,
} from "../projection/status.js";
import { canonicalJson, canonicalJsonEqual } from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeImmutableProtectedJsonFile,
} from "../security/protected-json.js";
import type {
  CompletedClaimReleaser,
  LifecycleProjectionWriter,
} from "./publication-coordinator.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const blockedHandoffPlanSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("blocked-handoff-plan"),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  workProduct: workProductIdentitySchema,
  adjudication: z.object({
    commandId: z.uuid(),
    completedAt: z.iso.datetime(),
    blockedStage: z.enum(["validation", "independent-review"]),
  }).strict(),
  projection: statusProjectionSchema,
  releaseCommand: freedClaimReleaseRequestSchema,
}).strict();

export type BlockedHandoffPlan = z.infer<typeof blockedHandoffPlanSchema>;

const planRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("blocked-handoff-plan-record"),
  checkpointReference: digestSchema,
  plan: blockedHandoffPlanSchema,
}).strict();

const projectionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("blocked-handoff-projection"),
  checkpointReference: digestSchema,
  receipt: projectionWriteReceiptSchema,
}).strict();

const releaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("blocked-handoff-release"),
  checkpointReference: digestSchema,
  receipt: freedClaimReleaseReceiptSchema,
}).strict();

export interface BlockedHandoffTransaction {
  readonly stage: "planned" | "projected" | "released";
  readonly plan: BlockedHandoffPlan;
  readonly projection?: ProjectionWriteReceipt;
  readonly release?: FreedClaimReleaseReceipt;
}

function deterministicUuid(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function brokerCompatibleBlockedHandoffReleaseCommand(
  command: FreedClaimReleaseRequest,
): FreedClaimReleaseRequest {
  const version = command.operationId[14];
  if (version === "4") {
    return command;
  }
  if (version !== "8") {
    throw new Error("Blocked handoff release operation uses an unsupported UUID version.");
  }
  return freedClaimReleaseRequestSchema.parse({
    ...command,
    operationId: `${command.operationId.slice(0, 14)}4${command.operationId.slice(15)}`,
  });
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}

function expectedReleaseReceipt(
  command: FreedClaimReleaseRequest,
): FreedClaimReleaseReceipt {
  return freedClaimReleaseReceiptSchema.parse({
    schemaVersion: 1,
    operationId: command.operationId,
    taskId: command.taskId,
    taskRevision: command.expectedTaskRevision,
    authorityClaimId: command.authorityClaimId,
    bindingDigest: command.bindingDigest,
    expectedHeartbeatAt: command.expectedHeartbeatAt,
    reason: command.reason,
    releasedAt: command.releasedAt,
    ...(command.custodyEpoch === undefined
      ? {}
      : { custodyEpoch: command.custodyEpoch }),
  });
}

export function planBlockedHandoff(input: {
  readonly adjudication: TrustedAdjudicationResult;
  readonly claim: DispatchClaim;
  readonly repository: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly bindingDigest: string;
  readonly heartbeatAt: string;
  readonly now: string;
}): BlockedHandoffPlan {
  const adjudication = trustedAdjudicationResultSchema.parse(
    input.adjudication,
  );
  if (adjudication.outcome !== "blocked") {
    throw new Error("Blocked handoff planning requires a blocked adjudication.");
  }
  const workProduct = adjudication.validation.workProduct;
  if (
    input.repository !==
      `${workProduct.repository.owner}/${workProduct.repository.name}` ||
    input.claim.issueNumber !== workProduct.issueNumber ||
    input.claim.claimId !== workProduct.claimId ||
    input.claim.custodyEpoch !== workProduct.custodyEpoch ||
    input.claim.hostId !== workProduct.hostId ||
    input.claim.branch !== workProduct.branch ||
    input.claim.worktree !== workProduct.worktree
  ) {
    throw new Error("Blocked handoff claim does not match the work product.");
  }
  const validationFailed =
    !adjudication.validation.passed ||
    adjudication.validation.commands.some((command) => command.exitCode !== 0);
  const blocker = validationFailed
    ? "Exact validation failed."
    : "Independent review did not pass.";
  const projection = buildStatusProjection({
    state: "blocked",
    stage: validationFailed ? "validation" : "independent-review",
    summary: "The completed work product did not pass trusted adjudication.",
    claim: input.claim,
    blocker,
    nextAction: "Owner reviews the adjudication evidence before retrying.",
    updatedAt: z.iso.datetime().parse(input.now),
  });
  const releaseCommand = freedClaimReleaseRequestSchema.parse({
    schemaVersion: 1,
    operationId: deterministicUuid({
      domain: "aubtown.blocked-handoff-release.v1",
      checkpointReference: workProduct.checkpointReference,
      taskId: input.taskId,
      authorityClaimId: input.claim.claimId,
    }),
    taskId: input.taskId,
    expectedTaskRevision: input.taskRevision,
    authorityClaimId: input.claim.claimId,
    bindingDigest: input.bindingDigest,
    custodyEpoch: input.claim.custodyEpoch,
    expectedHeartbeatAt: input.heartbeatAt,
    reason: "worker-completed",
    releasedAt: input.now,
  });
  return blockedHandoffPlanSchema.parse({
    schemaVersion: 1,
    kind: "blocked-handoff-plan",
    repository: input.repository,
    issueNumber: workProduct.issueNumber,
    workProduct,
    adjudication: {
      commandId: adjudication.commandId,
      completedAt: adjudication.completedAt,
      blockedStage: validationFailed ? "validation" : "independent-review",
    },
    projection,
    releaseCommand,
  });
}

export class BlockedHandoffTransactionStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Blocked handoff transaction root must be absolute.");
    }
  }

  async recordPlan(rawPlan: BlockedHandoffPlan): Promise<BlockedHandoffTransaction> {
    const plan = blockedHandoffPlanSchema.parse(rawPlan);
    const checkpoint = plan.workProduct.checkpointReference;
    await writeImmutableProtectedJsonFile({
      file: this.#path("blocked-plan", checkpoint),
      label: "Blocked handoff plan",
      value: {
        schemaVersion: 1,
        kind: "blocked-handoff-plan-record",
        checkpointReference: checkpoint,
        plan,
      },
    });
    return (await this.load(checkpoint))!;
  }

  async recordProjection(
    checkpointReference: string,
    rawReceipt: ProjectionWriteReceipt,
  ): Promise<BlockedHandoffTransaction> {
    const current = await this.#required(checkpointReference);
    const receipt = projectionWriteReceiptSchema.parse(rawReceipt);
    if (
      receipt.repository !== current.plan.repository ||
      receipt.issueNumber !== current.plan.issueNumber
    ) {
      throw new Error("Blocked projection receipt names another handoff.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("blocked-projection", checkpointReference),
      label: "Blocked handoff projection",
      value: {
        schemaVersion: 1,
        kind: "blocked-handoff-projection",
        checkpointReference,
        receipt,
      },
    });
    return (await this.load(checkpointReference))!;
  }

  async recordRelease(
    checkpointReference: string,
    rawReceipt: FreedClaimReleaseReceipt,
  ): Promise<BlockedHandoffTransaction> {
    const current = await this.#required(checkpointReference);
    if (current.projection === undefined) {
      throw new Error("Blocked claim cleanup requires lifecycle projection.");
    }
    const receipt = freedClaimReleaseReceiptSchema.parse(rawReceipt);
    const command = brokerCompatibleBlockedHandoffReleaseCommand(
      current.plan.releaseCommand,
    );
    if (!canonicalJsonEqual(receipt, expectedReleaseReceipt(command))) {
      throw new Error("Blocked claim cleanup changed its durable command.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("blocked-release", checkpointReference),
      label: "Blocked handoff release",
      value: {
        schemaVersion: 1,
        kind: "blocked-handoff-release",
        checkpointReference,
        receipt,
      },
    });
    return (await this.load(checkpointReference))!;
  }

  async load(checkpointReference: string): Promise<BlockedHandoffTransaction | null> {
    const checkpoint = digestSchema.parse(checkpointReference);
    const rawPlan = await this.#optional("blocked-plan", checkpoint);
    if (rawPlan === null) {
      return null;
    }
    const planRecord = planRecordSchema.parse(rawPlan);
    if (
      planRecord.checkpointReference !== checkpoint ||
      planRecord.plan.workProduct.checkpointReference !== checkpoint
    ) {
      throw new Error("Blocked handoff plan changed its file identity.");
    }
    const rawProjection = await this.#optional("blocked-projection", checkpoint);
    const rawRelease = await this.#optional("blocked-release", checkpoint);
    const projectionRecord =
      rawProjection === null
        ? undefined
        : projectionRecordSchema.parse(rawProjection);
    const releaseRecord =
      rawRelease === null ? undefined : releaseRecordSchema.parse(rawRelease);
    for (const record of [projectionRecord, releaseRecord]) {
      if (record !== undefined && record.checkpointReference !== checkpoint) {
        throw new Error("Blocked handoff stage changed its file identity.");
      }
    }
    const projection = projectionRecord?.receipt;
    const release = releaseRecord?.receipt;
    if (
      projection !== undefined &&
      (projection.repository !== planRecord.plan.repository ||
        projection.issueNumber !== planRecord.plan.issueNumber)
    ) {
      throw new Error("Blocked handoff projection changed its identity.");
    }
    if (release !== undefined) {
      if (
        projection === undefined ||
        !canonicalJsonEqual(
          release,
          expectedReleaseReceipt(
            brokerCompatibleBlockedHandoffReleaseCommand(
              planRecord.plan.releaseCommand,
            ),
          ),
        )
      ) {
        throw new Error("Blocked handoff release changed its plan.");
      }
    }
    return {
      stage:
        release !== undefined
          ? "released"
          : projection !== undefined
            ? "projected"
            : "planned",
      plan: planRecord.plan,
      ...(projection === undefined ? {} : { projection }),
      ...(release === undefined ? {} : { release }),
    };
  }

  async #required(checkpointReference: string): Promise<BlockedHandoffTransaction> {
    const current = await this.load(checkpointReference);
    if (current === null) {
      throw new Error("Blocked handoff plan is missing.");
    }
    return current;
  }

  async #optional(kind: string, checkpointReference: string): Promise<unknown | null> {
    try {
      return await loadProtectedJsonFile({
        file: this.#path(kind, checkpointReference),
        label: `Blocked handoff ${kind}`,
        maxBytes: 2 * 1_024 * 1_024,
      });
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  #path(kind: string, checkpointReference: string): string {
    return path.join(this.root, `${kind}-${checkpointReference}.json`);
  }
}

export class BlockedHandoffCoordinator {
  constructor(
    private readonly transactions: BlockedHandoffTransactionStore,
    private readonly projections: LifecycleProjectionWriter,
    private readonly claims: CompletedClaimReleaser,
  ) {}

  async run(input: {
    readonly plan: BlockedHandoffPlan;
    readonly projectionApproved: boolean;
  }): Promise<BlockedHandoffTransaction> {
    let transaction = await this.transactions.recordPlan(input.plan);
    if (!input.projectionApproved && transaction.projection === undefined) {
      throw new Error(
        "Blocked handoff requires the lifecycle projection pilot gate.",
      );
    }
    if (transaction.projection === undefined) {
      const [owner, repository, extra] = transaction.plan.repository.split("/");
      if (owner === undefined || repository === undefined || extra !== undefined) {
        throw new Error("Blocked handoff repository is malformed.");
      }
      const receipt = await this.projections.write({
        owner,
        repository,
        issueNumber: transaction.plan.issueNumber,
        projection: transaction.plan.projection,
        projectionApproved: input.projectionApproved,
      });
      transaction = await this.transactions.recordProjection(
        transaction.plan.workProduct.checkpointReference,
        receipt,
      );
    }
    if (transaction.release === undefined) {
      const command = brokerCompatibleBlockedHandoffReleaseCommand(
        transaction.plan.releaseCommand,
      );
      const receipt = await this.claims.release(command);
      transaction = await this.transactions.recordRelease(
        transaction.plan.workProduct.checkpointReference,
        receipt,
      );
    }
    return transaction;
  }
}
