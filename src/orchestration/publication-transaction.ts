import path from "node:path";
import { z } from "zod";
import {
  freedClaimReleaseReceiptSchema,
  freedClaimReleaseRequestSchema,
  type FreedClaimReleaseReceipt,
  type FreedClaimReleaseRequest,
} from "../adapters/freed/claim-broker.js";
import {
  draftPublicationReceiptSchema,
  type DraftPublicationReceipt,
} from "../publication/draft-publisher.js";
import type { PublicationPlan } from "../publication/policy.js";
import {
  projectionWriteReceiptSchema,
  type ProjectionWriteReceipt,
} from "../projection/github-writer.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeImmutableProtectedJsonFile,
} from "../security/protected-json.js";
import {
  initializePublication,
  recordPublication,
} from "./publication-registry.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const planRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("publication-plan"),
  checkpointReference: digestSchema,
  plan: z.unknown(),
}).strict();

const receiptRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("publication-receipt"),
  checkpointReference: digestSchema,
  receipt: draftPublicationReceiptSchema,
}).strict();

const projectionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("publication-projection"),
  checkpointReference: digestSchema,
  receipt: projectionWriteReceiptSchema,
}).strict();

const releaseCommandRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("publication-release-command"),
  checkpointReference: digestSchema,
  command: freedClaimReleaseRequestSchema,
}).strict();

const releaseReceiptRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("publication-release-receipt"),
  checkpointReference: digestSchema,
  receipt: freedClaimReleaseReceiptSchema,
}).strict();

export type PublicationTransactionStage =
  | "planned"
  | "published"
  | "projected"
  | "released";

export interface PublicationTransaction {
  readonly checkpointReference: string;
  readonly stage: PublicationTransactionStage;
  readonly plan: PublicationPlan;
  readonly publication?: DraftPublicationReceipt;
  readonly projection?: ProjectionWriteReceipt;
  readonly releaseCommand?: FreedClaimReleaseRequest;
  readonly release?: FreedClaimReleaseReceipt;
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

export class PublicationTransactionStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Publication transaction root must be absolute.");
    }
  }

  async recordPlan(rawPlan: PublicationPlan): Promise<PublicationTransaction> {
    const state = initializePublication(null, rawPlan);
    const checkpointReference = state.plan.workProduct?.checkpointReference;
    if (checkpointReference === undefined) {
      throw new Error("Publication plan lacks an exact checkpoint reference.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("plan", checkpointReference),
      label: "Publication transaction plan",
      value: {
        schemaVersion: 1,
        kind: "publication-plan",
        checkpointReference,
        plan: state.plan,
      },
    });
    return (await this.load(checkpointReference))!;
  }

  async recordPublication(
    checkpointReference: string,
    rawReceipt: DraftPublicationReceipt,
  ): Promise<PublicationTransaction> {
    const current = await this.#required(checkpointReference);
    const receipt = recordPublication(
      initializePublication(null, current.plan),
      rawReceipt,
    ).receipt!;
    await writeImmutableProtectedJsonFile({
      file: this.#path("receipt", current.checkpointReference),
      label: "Publication transaction receipt",
      value: {
        schemaVersion: 1,
        kind: "publication-receipt",
        checkpointReference: current.checkpointReference,
        receipt,
      },
    });
    return (await this.load(current.checkpointReference))!;
  }

  async recordProjection(
    checkpointReference: string,
    rawReceipt: ProjectionWriteReceipt,
  ): Promise<PublicationTransaction> {
    const current = await this.#required(checkpointReference);
    if (current.publication === undefined || current.plan.projection === undefined) {
      throw new Error("Lifecycle projection requires a published draft plan.");
    }
    const receipt = projectionWriteReceiptSchema.parse(rawReceipt);
    const workProduct = current.plan.workProduct!;
    if (
      receipt.repository !== current.plan.repository ||
      receipt.issueNumber !== workProduct.issueNumber
    ) {
      throw new Error("Lifecycle projection receipt names another publication.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("projection", current.checkpointReference),
      label: "Publication transaction projection",
      value: {
        schemaVersion: 1,
        kind: "publication-projection",
        checkpointReference: current.checkpointReference,
        receipt,
      },
    });
    return (await this.load(current.checkpointReference))!;
  }

  async recordReleaseCommand(
    checkpointReference: string,
    rawCommand: FreedClaimReleaseRequest,
  ): Promise<PublicationTransaction> {
    const current = await this.#required(checkpointReference);
    if (current.projection === undefined) {
      throw new Error("Exact claim cleanup requires lifecycle projection first.");
    }
    const command = freedClaimReleaseRequestSchema.parse(rawCommand);
    const workProduct = current.plan.workProduct!;
    if (
      command.authorityClaimId !== workProduct.claimId ||
      command.custodyEpoch !== workProduct.custodyEpoch ||
      command.reason !== "worker-completed"
    ) {
      throw new Error("Claim cleanup command names another publication.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("release-command", current.checkpointReference),
      label: "Publication transaction release command",
      value: {
        schemaVersion: 1,
        kind: "publication-release-command",
        checkpointReference: current.checkpointReference,
        command,
      },
    });
    return (await this.load(current.checkpointReference))!;
  }

  async recordRelease(
    checkpointReference: string,
    rawReceipt: FreedClaimReleaseReceipt,
  ): Promise<PublicationTransaction> {
    const current = await this.#required(checkpointReference);
    if (current.releaseCommand === undefined) {
      throw new Error("Claim cleanup receipt lacks its durable command.");
    }
    const receipt = freedClaimReleaseReceiptSchema.parse(rawReceipt);
    if (!canonicalJsonEqual(receipt, expectedReleaseReceipt(current.releaseCommand))) {
      throw new Error("Claim cleanup receipt changed its durable command.");
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path("release-receipt", current.checkpointReference),
      label: "Publication transaction release receipt",
      value: {
        schemaVersion: 1,
        kind: "publication-release-receipt",
        checkpointReference: current.checkpointReference,
        receipt,
      },
    });
    return (await this.load(current.checkpointReference))!;
  }

  async load(checkpointReference: string): Promise<PublicationTransaction | null> {
    const checkpoint = digestSchema.parse(checkpointReference);
    const rawPlan = await this.#optional("plan", checkpoint);
    if (rawPlan === null) {
      return null;
    }
    const planRecord = planRecordSchema.parse(rawPlan);
    if (planRecord.checkpointReference !== checkpoint) {
      throw new Error("Stored publication plan changed its file identity.");
    }
    const state = initializePublication(
      null,
      planRecord.plan as PublicationPlan,
    );
    if (state.plan.workProduct?.checkpointReference !== checkpoint) {
      throw new Error("Stored publication plan changed its checkpoint identity.");
    }

    const rawPublication = await this.#optional("receipt", checkpoint);
    const rawProjection = await this.#optional("projection", checkpoint);
    const rawReleaseCommand = await this.#optional("release-command", checkpoint);
    const rawReleaseReceipt = await this.#optional("release-receipt", checkpoint);
    const publicationRecord =
      rawPublication === null ? undefined : receiptRecordSchema.parse(rawPublication);
    const projectionRecord =
      rawProjection === null
        ? undefined
        : projectionRecordSchema.parse(rawProjection);
    const releaseCommandRecord =
      rawReleaseCommand === null
        ? undefined
        : releaseCommandRecordSchema.parse(rawReleaseCommand);
    const releaseReceiptRecord =
      rawReleaseReceipt === null
        ? undefined
        : releaseReceiptRecordSchema.parse(rawReleaseReceipt);
    for (const record of [
      publicationRecord,
      projectionRecord,
      releaseCommandRecord,
      releaseReceiptRecord,
    ]) {
      if (record !== undefined && record.checkpointReference !== checkpoint) {
        throw new Error("Stored publication stage changed its file identity.");
      }
    }
    const publication = publicationRecord?.receipt;
    if (publication !== undefined) {
      recordPublication(state, publication);
    }
    const projection = projectionRecord?.receipt;
    const releaseCommand = releaseCommandRecord?.command;
    const release = releaseReceiptRecord?.receipt;
    const workProduct = state.plan.workProduct!;

    if (projection !== undefined && publication === undefined) {
      throw new Error("Stored lifecycle projection lacks a publication receipt.");
    }
    if (
      projection !== undefined &&
      (projection.repository !== state.plan.repository ||
        projection.issueNumber !== workProduct.issueNumber)
    ) {
      throw new Error("Stored lifecycle projection changed publication identity.");
    }
    if (releaseCommand !== undefined && projection === undefined) {
      throw new Error("Stored claim cleanup command lacks lifecycle projection.");
    }
    if (
      releaseCommand !== undefined &&
      (releaseCommand.authorityClaimId !== workProduct.claimId ||
        releaseCommand.custodyEpoch !== workProduct.custodyEpoch ||
        releaseCommand.reason !== "worker-completed")
    ) {
      throw new Error("Stored claim cleanup command changed publication identity.");
    }
    if (release !== undefined) {
      if (
        releaseCommand === undefined ||
        !canonicalJsonEqual(release, expectedReleaseReceipt(releaseCommand))
      ) {
        throw new Error("Stored claim cleanup receipt changed its command.");
      }
    }
    return {
      checkpointReference: checkpoint,
      stage:
        release !== undefined
          ? "released"
          : projection !== undefined
            ? "projected"
            : publication !== undefined
              ? "published"
              : "planned",
      plan: state.plan,
      ...(publication === undefined ? {} : { publication }),
      ...(projection === undefined ? {} : { projection }),
      ...(releaseCommand === undefined ? {} : { releaseCommand }),
      ...(release === undefined ? {} : { release }),
    };
  }

  async #required(checkpointReference: string): Promise<PublicationTransaction> {
    const current = await this.load(checkpointReference);
    if (current === null) {
      throw new Error("Publication transaction plan is missing.");
    }
    return current;
  }

  async #optional(kind: string, checkpointReference: string): Promise<unknown | null> {
    try {
      return await loadProtectedJsonFile({
        file: this.#path(kind, checkpointReference),
        label: `Publication transaction ${kind}`,
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
