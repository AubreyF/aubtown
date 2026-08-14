import type { HostGatewayReceipt } from "../gateway/receipt.js";
import type { ExactValidationReceipt, IndependentReviewReceipt } from "./receipts.js";
import type { AdjudicationCommand } from "./command.js";
import {
  HostAdjudicationJournal,
  type HostAdjudicationRecord,
  type HostReviewHandle,
} from "./journal.js";
import type { ExactValidationRunner } from "./validation-runner.js";

export interface AdjudicationGateway {
  pollAdjudication(
    accountId: string,
    reviewerDriverId: "codex-app-server-review-v1",
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "adjudication-poll" }>>;
  reportValidation(
    input: ExactValidationReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "validation-receipt" }>>;
  reportReview(
    input: IndependentReviewReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "review-receipt" }>>;
}

export interface IndependentReviewer {
  readonly id: "codex-app-server-review-v1";
  start(input: {
    readonly workProduct: AdjudicationCommand["workProduct"];
    readonly qualification: AdjudicationCommand["qualification"];
    readonly repositoryRoot: string;
  }): Promise<HostReviewHandle>;
  wait(handle: HostReviewHandle): Promise<IndependentReviewReceipt>;
}

export class HostAdjudicationSupervisor {
  #activeCommandId: string | undefined;
  #active: Promise<void> | undefined;

  constructor(
    private readonly accountId: string,
    private readonly validation: Pick<ExactValidationRunner, "run">,
    private readonly reviewer: IndependentReviewer,
    private readonly journal: HostAdjudicationJournal,
    private readonly gateway: AdjudicationGateway,
    private readonly validationEnvironment: NodeJS.ProcessEnv,
    private readonly eventSink: (event: Readonly<Record<string, unknown>>) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<string> {
    let record = await this.journal.read();
    if (
      record?.stage === "validation-starting" ||
      record?.stage === "review-starting"
    ) {
      throw new Error(
        `Adjudication ${record.stage} outcome is ambiguous and requires reconciliation.`,
      );
    }
    if (record?.stage === "validated") {
      await this.#reportValidation(record);
      record = await this.journal.read();
    }
    if (record?.stage === "reviewed") {
      await this.#reportReview(record);
      record = await this.journal.read();
    }
    if (record?.stage === "review-started") {
      this.#watchReview(record);
      return "review-running";
    }
    if (this.#active !== undefined) {
      return "running";
    }
    if (record?.stage === "failed") {
      return "failed";
    }

    const poll = await this.gateway.pollAdjudication(
      this.accountId,
      this.reviewer.id,
    );
    if (poll.command === null || poll.action === null) {
      return poll.reason;
    }
    this.#assertLocal(poll.command);
    const accepted = await this.journal.accept(
      poll.command,
      poll.action,
      this.now().toISOString(),
    );
    if (
      !accepted.acceptedNow &&
      accepted.record.stage !== "validation-reported" &&
      accepted.record.stage !== "accepted"
    ) {
      return accepted.record.stage;
    }
    if (poll.action === "validate") {
      this.#watchValidation(accepted.record);
      return "validation-running";
    }
    this.#watchReviewStart(accepted.record);
    return "review-starting";
  }

  async flush(): Promise<void> {
    const record = await this.journal.read();
    if (record?.stage === "validated") {
      await this.#reportValidation(record);
    } else if (record?.stage === "reviewed") {
      await this.#reportReview(record);
    }
  }

  async activeClaimIds(): Promise<readonly string[]> {
    const record = await this.journal.read();
    return record !== null && record.stage !== "complete"
      ? [record.command.workProduct.claimId]
      : [];
  }

  async shutdown(timeoutMs = 120_000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Adjudication shutdown timeout must be a positive integer.");
    }
    if (this.#active !== undefined) {
      await Promise.race([
        this.#active,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Adjudication shutdown timed out.")),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    }
    await this.flush();
    const record = await this.journal.read();
    if (
      record?.stage === "validation-starting" ||
      record?.stage === "review-starting"
    ) {
      throw new Error("Adjudication shutdown left an ambiguous start boundary.");
    }
  }

  #watchValidation(record: HostAdjudicationRecord): void {
    this.#watch(record.command.commandId, async () => {
      const starting = await this.journal.transition(
        record.command.commandId,
        (current) => ({ ...current, stage: "validation-starting" }),
      );
      let receipt: ExactValidationReceipt;
      try {
        receipt = await this.validation.run({
          workProduct: starting.command.workProduct,
          commands: starting.command.validationCommands,
          env: this.validationEnvironment,
        });
      } catch (error) {
        await this.#fail(starting.command.commandId, error);
        return;
      }
      const validated = await this.journal.transition(
        starting.command.commandId,
        (current) => ({ ...current, stage: "validated", validation: receipt }),
      );
      await this.#reportValidation(validated);
    });
  }

  #watchReviewStart(record: HostAdjudicationRecord): void {
    this.#watch(record.command.commandId, async () => {
      const starting = await this.journal.transition(
        record.command.commandId,
        (current) => ({ ...current, stage: "review-starting" }),
      );
      const handle = await this.reviewer.start({
        workProduct: starting.command.workProduct,
        qualification: starting.command.qualification,
        repositoryRoot: starting.command.workProduct.worktree,
      });
      const started = await this.journal.transition(
        starting.command.commandId,
        (current) => ({ ...current, stage: "review-started", reviewHandle: handle }),
      );
      await this.#finishReview(started);
    });
  }

  #watchReview(record: HostAdjudicationRecord): void {
    this.#watch(record.command.commandId, async () => {
      await this.#finishReview(record);
    });
  }

  async #finishReview(record: HostAdjudicationRecord): Promise<void> {
    if (record.reviewHandle === undefined) {
      throw new Error("Started adjudication review has no durable handle.");
    }
    const receipt = await this.reviewer.wait(record.reviewHandle);
    const reviewed = await this.journal.transition(
      record.command.commandId,
      (current) => ({ ...current, stage: "reviewed", review: receipt }),
    );
    await this.#reportReview(reviewed);
  }

  async #reportValidation(record: HostAdjudicationRecord): Promise<void> {
    if (record.validation === undefined) {
      throw new Error("Validated adjudication has no receipt.");
    }
    const receipt = await this.gateway.reportValidation(record.validation);
    const terminal = receipt.stage === "ready" || receipt.stage === "blocked";
    await this.journal.transition(record.command.commandId, (current) => ({
      ...current,
      stage: terminal ? "complete" : "validation-reported",
      validationReportedAt: receipt.acceptedAt,
      ...(terminal ? { finishedAt: receipt.acceptedAt } : {}),
    }));
  }

  async #reportReview(record: HostAdjudicationRecord): Promise<void> {
    if (record.review === undefined) {
      throw new Error("Reviewed adjudication has no receipt.");
    }
    const receipt = await this.gateway.reportReview(record.review);
    await this.journal.transition(record.command.commandId, (current) => ({
      ...current,
      stage: "complete",
      reviewReportedAt: receipt.acceptedAt,
      finishedAt: receipt.acceptedAt,
    }));
  }

  #watch(commandId: string, operation: () => Promise<void>): void {
    if (this.#activeCommandId === commandId) {
      return;
    }
    this.#activeCommandId = commandId;
    this.#active = operation()
      .catch((error: unknown) => {
        this.eventSink({
          event: "adjudication-watch-failed",
          commandId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.#activeCommandId === commandId) {
          this.#activeCommandId = undefined;
          this.#active = undefined;
        }
      });
  }

  async #fail(commandId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.journal.transition(commandId, (current) => ({
      ...current,
      stage: "failed",
      failure: message,
      finishedAt: this.now().toISOString(),
    }));
    this.eventSink({ event: "adjudication-failed", commandId, message });
  }

  #assertLocal(command: AdjudicationCommand): void {
    if (command.accountId !== this.accountId) {
      throw new Error("Adjudication command targets another local account.");
    }
    if (command.reviewerDriverId !== this.reviewer.id) {
      throw new Error("Adjudication command targets another reviewer driver.");
    }
  }
}
