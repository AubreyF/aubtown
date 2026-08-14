import path from "node:path";
import { z } from "zod";
import type { AccountUsageSnapshot } from "../domain/types.js";
import type { UsageSource } from "../drivers/worker.js";
import { mergeUsageObservation, decideQuota } from "../policy/quota.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeImmutableProtectedJsonFile,
} from "../security/protected-json.js";
import { adjudicationCommandSchema, type AdjudicationCommand } from "./command.js";
import {
  assessHandoff,
  exactValidationReceiptSchema,
  independentReviewReceiptSchema,
  type ExactValidationReceipt,
  type IndependentReviewReceipt,
} from "./receipts.js";
import {
  HostAdjudicationJournal,
  type HostAdjudicationRecord,
  type HostReviewHandle,
} from "./journal.js";
import type { ExactValidationRunner } from "./validation-runner.js";
import type { IndependentReviewer } from "./supervisor.js";

export const trustedAdjudicationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("trusted-adjudication"),
    commandId: z.uuid(),
    outcome: z.enum(["ready", "blocked"]),
    validation: exactValidationReceiptSchema,
    review: independentReviewReceiptSchema.optional(),
    completedAt: z.iso.datetime(),
  })
  .superRefine((result, context) => {
    const ready =
      result.validation.passed &&
      result.validation.commands.every((command) => command.exitCode === 0) &&
      result.review?.verdict === "pass";
    if ((result.outcome === "ready") !== ready) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Trusted adjudication outcome contradicts its receipts.",
      });
    }
  });

export type TrustedAdjudicationResult = z.infer<
  typeof trustedAdjudicationResultSchema
>;

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}

export class TrustedAdjudicationResultStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Trusted adjudication result root must be absolute.");
    }
  }

  async record(
    value: TrustedAdjudicationResult,
  ): Promise<TrustedAdjudicationResult> {
    const result = trustedAdjudicationResultSchema.parse(value);
    const current = await this.load(result.commandId);
    if (current !== null) {
      if (!canonicalJsonEqual(current, result)) {
        throw new Error("Trusted adjudication conflicts with its prior result.");
      }
      return current;
    }
    await writeImmutableProtectedJsonFile({
      file: this.#path(result.commandId),
      label: "Trusted adjudication result",
      value: result,
    });
    return result;
  }

  async load(commandId: string): Promise<TrustedAdjudicationResult | null> {
    const id = z.uuid().parse(commandId);
    try {
      return trustedAdjudicationResultSchema.parse(
        await loadProtectedJsonFile({
          file: this.#path(id),
          label: "Trusted adjudication result",
        }),
      );
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  #path(commandId: string): string {
    return path.join(this.root, `adjudication-${commandId}.json`);
  }
}

export interface ReviewInterrupter {
  interrupt(handle: HostReviewHandle): Promise<void>;
}

export class TrustedAdjudicationRunner {
  constructor(
    private readonly validation: Pick<ExactValidationRunner, "run">,
    private readonly reviewer: IndependentReviewer,
    private readonly usage: UsageSource,
    private readonly interrupter: ReviewInterrupter,
    private readonly journal: HostAdjudicationJournal,
    private readonly results: TrustedAdjudicationResultStore,
    private readonly validationEnvironment: NodeJS.ProcessEnv,
    private readonly now: () => Date = () => new Date(),
    private readonly sampleIntervalMs = 30_000,
  ) {
    if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1) {
      throw new Error("Adjudication quota sample interval must be positive.");
    }
  }

  async run(rawCommand: AdjudicationCommand): Promise<TrustedAdjudicationResult> {
    const command = adjudicationCommandSchema.parse(rawCommand);
    const existing = await this.results.load(command.commandId);
    if (existing !== null) {
      return existing;
    }
    await this.journal.accept(command, "validate", this.now().toISOString());
    let record = await this.journal.read();
    if (record === null || record.command.commandId !== command.commandId) {
      throw new Error("Adjudication journal lost the accepted command.");
    }
    const validation = await this.#validated(record);
    if (!validation.passed) {
      return await this.#finish(command, validation);
    }
    record = (await this.journal.read())!;
    const review = await this.#reviewed(record);
    return await this.#finish(command, validation, review);
  }

  async #validated(
    record: HostAdjudicationRecord,
  ): Promise<ExactValidationReceipt> {
    if (record.validation !== undefined) {
      return record.validation;
    }
    const starting = await this.journal.transition(
      record.command.commandId,
      (current) => ({ ...current, stage: "validation-starting" }),
    );
    const validation = await this.validation.run({
      workProduct: starting.command.workProduct,
      commands: starting.command.validationCommands,
      env: this.validationEnvironment,
    });
    if (!canonicalJsonEqual(validation.workProduct, starting.command.workProduct)) {
      throw new Error("Validation changed the admitted work product.");
    }
    await this.journal.transition(starting.command.commandId, (current) => ({
      ...current,
      stage: "validated",
      validation,
    }));
    return validation;
  }

  async #reviewed(
    record: HostAdjudicationRecord,
  ): Promise<IndependentReviewReceipt> {
    if (record.review !== undefined) {
      return record.review;
    }
    let usage: AccountUsageSnapshot = record.command.usageAtAdmission;
    const before = await this.usage.read(record.command.accountId, []);
    usage = mergeUsageObservation({ previous: usage, observation: before });
    const beforeDecision = decideQuota({
      snapshot: usage,
      now: before.observedAt,
    });
    if (
      beforeDecision.action !== "admit" &&
      beforeDecision.action !== "throttle"
    ) {
      throw new Error(
        `Independent review is blocked by quota: ${beforeDecision.reason}.`,
      );
    }
    if (record.stage === "review-starting" && record.reviewHandle === undefined) {
      throw new Error(
        "Independent review start is ambiguous and requires reconciliation.",
      );
    }
    const persistedHandle = record.reviewHandle;
    let handle = persistedHandle;
    if (handle === undefined) {
      const starting = await this.journal.transition(
        record.command.commandId,
        (current) => ({ ...current, stage: "review-starting" }),
      );
      handle = await this.reviewer.start({
        workProduct: starting.command.workProduct,
        qualification: starting.command.qualification,
        repositoryRoot: starting.command.workProduct.worktree,
      });
      await this.journal.transition(starting.command.commandId, (current) => ({
        ...current,
        stage: "review-started",
        reviewHandle: handle,
      }));
    }
    if (persistedHandle !== undefined) {
      if (this.reviewer.recover === undefined) {
        throw new Error("Independent reviewer cannot recover a durable handle.");
      }
      await this.reviewer.recover(handle);
    }
    const reviewPromise = this.reviewer.wait(handle);
    for (;;) {
      const outcome = await Promise.race([
        reviewPromise.then((review) => ({ kind: "review" as const, review })),
        new Promise<{ readonly kind: "sample" }>((resolve) => {
          const timer = setTimeout(
            () => resolve({ kind: "sample" }),
            this.sampleIntervalMs,
          );
          timer.unref();
        }),
      ]);
      if (outcome.kind === "review") {
        await this.journal.transition(record.command.commandId, (current) => ({
          ...current,
          stage: "reviewed",
          review: outcome.review,
        }));
        return outcome.review;
      }
      try {
        const observation = await this.usage.read(record.command.accountId, [
          handle.turnId,
        ]);
        usage = mergeUsageObservation({ previous: usage, observation });
        const decision = decideQuota({
          snapshot: usage,
          now: observation.observedAt,
        });
        if (decision.action === "interrupt") {
          throw new Error(
            `Independent review interrupted by quota: ${decision.reason}.`,
          );
        }
      } catch (error) {
        await this.interrupter.interrupt(handle).catch(() => undefined);
        throw error;
      }
    }
  }

  async #finish(
    command: AdjudicationCommand,
    validation: ExactValidationReceipt,
    review?: IndependentReviewReceipt,
  ): Promise<TrustedAdjudicationResult> {
    if (!canonicalJsonEqual(validation.workProduct, command.workProduct)) {
      throw new Error("Validation result changes the adjudication work product.");
    }
    if (
      review !== undefined &&
      !canonicalJsonEqual(review.workProduct, command.workProduct)
    ) {
      throw new Error("Review result changes the adjudication work product.");
    }
    const outcome =
      review !== undefined &&
      assessHandoff({
        workProduct: command.workProduct,
        validation,
        review,
      }).ready
        ? "ready"
        : "blocked";
    const result = await this.results.record({
      schemaVersion: 1,
      kind: "trusted-adjudication",
      commandId: command.commandId,
      outcome,
      validation,
      ...(review === undefined ? {} : { review }),
      completedAt: this.now().toISOString(),
    });
    await this.journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "complete",
      ...(review === undefined ? {} : { review }),
      finishedAt: result.completedAt,
    }));
    return result;
  }
}
