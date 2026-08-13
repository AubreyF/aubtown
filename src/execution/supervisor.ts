import type { HostGatewayReceipt } from "../orchestration/host-gateway.js";
import type {
  WorkerDriver,
  WorkerTurnHandle,
} from "../drivers/worker.js";
import type {
  ExecutorCommandReceipt,
  ExecutorReconcileRequest,
  ExecutorStartCommand,
} from "./command.js";
import {
  HostExecutionJournal,
  type HostExecutionRecord,
} from "./journal.js";
import type {
  ExecutionCheckpointManager,
  TerminalExecutionStatus,
} from "./checkpoint-manager.js";

export interface ExecutorReceiptGateway {
  reportExecutor(
    input: Omit<ExecutorCommandReceipt, "observedAt">,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "executor-receipt" }>>;
  reconcileExecutor(
    input: ExecutorReconcileRequest,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "executor-reconcile" }>>;
}

export interface ExecutionTurnTracker {
  track(accountId: string, handle: WorkerTurnHandle): void;
  untrack(accountId: string, turnId: string): void;
}

export type ExecutionEvent = Readonly<Record<string, unknown>> & {
  readonly event: string;
};

export class HostExecutionSupervisor {
  #watchingTurnId: string | undefined;

  constructor(
    private readonly accountId: string,
    private readonly worker: WorkerDriver,
    private readonly journal: HostExecutionJournal,
    private readonly gateway: ExecutorReceiptGateway,
    private readonly turns: ExecutionTurnTracker,
    private readonly eventSink: (event: ExecutionEvent) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly checkpoints?: ExecutionCheckpointManager,
  ) {}

  async recover(): Promise<void> {
    const record = await this.journal.read();
    if (record === null) {
      return;
    }
    if (record.stage === "accepted") {
      throw new Error(
        "Executor command start outcome is ambiguous and requires reconciliation.",
      );
    }
    if (record.stage !== "started") {
      await this.#reportIfNeeded(record);
      return;
    }
    const handle = this.#requiredHandle(record);
    if (this.#watchingTurnId === handle.turnId) {
      return;
    }
    const reconciliation = await this.gateway.reconcileExecutor({
      commandId: record.command.commandId,
      claimId: record.command.claim.claimId,
      custodyEpoch: record.command.claim.custodyEpoch,
      accountId: record.command.accountId,
      threadId: handle.threadId,
      turnId: handle.turnId,
    });
    if (reconciliation.action !== "resume") {
      this.eventSink({
        event: "executor-turn-quarantined",
        commandId: record.command.commandId,
        turnId: handle.turnId,
        reason: reconciliation.reason,
      });
      return;
    }
    const status = await this.worker.recover(handle, record.command.repositoryRoot);
    if (status === "running") {
      this.turns.track(this.accountId, handle);
      await this.#reportIfNeeded(record);
      this.#watch(record.command, handle);
      this.eventSink({
        event: "executor-turn-recovered",
        commandId: record.command.commandId,
        turnId: handle.turnId,
      });
      return;
    }
    await this.#finish(record.command, handle, status);
  }

  async accept(command: ExecutorStartCommand): Promise<void> {
    if (command.accountId !== this.accountId) {
      throw new Error("Executor command targets another local account.");
    }
    const acceptance = await this.journal.accept(command, this.now().toISOString());
    if (!acceptance.acceptedNow) {
      if (acceptance.record.stage === "accepted") {
        throw new Error(
          "Executor command start outcome is ambiguous and requires reconciliation.",
        );
      }
      await this.#resumeExisting(acceptance.record);
      return;
    }
    const handle = await this.worker.start({
      claim: command.claim,
      qualification: command.qualification,
      prompt: command.prompt,
      repositoryRoot: command.repositoryRoot,
    });
    const started = await this.journal.started(command.commandId, handle);
    this.turns.track(this.accountId, handle);
    await this.#reportIfNeeded(started);
    this.#watch(command, handle);
    this.eventSink({
      event: "executor-turn-started",
      commandId: command.commandId,
      threadId: handle.threadId,
      turnId: handle.turnId,
    });
  }

  async flush(): Promise<void> {
    const record = await this.journal.read();
    if (record !== null && record.stage !== "accepted") {
      await this.#reportIfNeeded(record);
    }
  }

  async activeClaimIds(): Promise<readonly string[]> {
    const record = await this.journal.read();
    return record !== null &&
      (record.stage === "accepted" || record.stage === "started")
      ? [record.command.claim.claimId]
      : [];
  }

  async #resumeExisting(record: HostExecutionRecord): Promise<void> {
    if (record.stage === "started") {
      const handle = this.#requiredHandle(record);
      this.turns.track(this.accountId, handle);
      await this.#reportIfNeeded(record);
      this.#watch(record.command, handle);
      return;
    }
    if (record.stage !== "accepted") {
      await this.#reportIfNeeded(record);
    }
  }

  #watch(command: ExecutorStartCommand, handle: WorkerTurnHandle): void {
    if (this.#watchingTurnId === handle.turnId) {
      return;
    }
    this.#watchingTurnId = handle.turnId;
    void this.worker
      .wait(handle)
      .then(async (status) => await this.#finish(command, handle, status))
      .catch((error: unknown) => {
        this.eventSink({
          event: "executor-turn-watch-failed",
          commandId: command.commandId,
          turnId: handle.turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.#watchingTurnId === handle.turnId) {
          this.#watchingTurnId = undefined;
        }
      });
  }

  async #finish(
    command: ExecutorStartCommand,
    handle: WorkerTurnHandle,
    status: TerminalExecutionStatus,
  ): Promise<void> {
    const finished = await this.journal.finish(
      command.commandId,
      status,
      this.now().toISOString(),
    );
    this.turns.untrack(this.accountId, handle.turnId);
    await this.#reportIfNeeded(finished);
    this.eventSink({
      event: "executor-turn-finished",
      commandId: command.commandId,
      turnId: handle.turnId,
      status,
    });
  }

  async #reportIfNeeded(record: HostExecutionRecord): Promise<void> {
    if (record.reportedAt !== undefined || record.stage === "accepted") {
      return;
    }
    const ready = await this.#checkpointIfNeeded(record);
    if (ready.stage === "accepted") {
      throw new Error("An unstarted execution cannot be reported.");
    }
    const handle = this.#requiredHandle(ready);
    await this.gateway.reportExecutor({
      commandId: ready.command.commandId,
      claimId: ready.command.claim.claimId,
      custodyEpoch: ready.command.claim.custodyEpoch,
      accountId: ready.command.accountId,
      stage: ready.stage,
      threadId: handle.threadId,
      turnId: handle.turnId,
    });
    await this.journal.reported(ready.command.commandId, this.now().toISOString());
  }

  async #checkpointIfNeeded(record: HostExecutionRecord): Promise<HostExecutionRecord> {
    if (this.checkpoints === undefined || record.stage === "started") {
      return record;
    }
    if (record.stage === "accepted" || record.finishedAt === undefined) {
      throw new Error("Only a terminal execution can create a custody checkpoint.");
    }
    const terminalStatus = record.stage;
    const finishedAt = record.finishedAt;
    let current = record;
    if (current.checkpoint === undefined) {
      const captured = await this.checkpoints.capture({
        command: current.command,
        status: terminalStatus,
        createdAt: finishedAt,
      });
      current = await this.journal.checkpointCaptured(
        current.command.commandId,
        captured,
      );
    }
    let checkpoint = current.checkpoint;
    if (checkpoint === undefined) {
      throw new Error("Terminal execution has no captured checkpoint.");
    }
    if (checkpoint.storageReceipt === undefined) {
      const stored = await this.checkpoints.upload({
        command: current.command,
        checkpoint,
      });
      current = await this.journal.checkpointStored(
        current.command.commandId,
        stored,
      );
      checkpoint = current.checkpoint;
      if (checkpoint === undefined) {
        throw new Error("Terminal execution lost its captured checkpoint.");
      }
    }
    if (checkpoint.storageReceipt === undefined) {
      throw new Error("Terminal execution has no checkpoint storage receipt.");
    }
    if (checkpoint.catalogedAt === undefined) {
      await this.checkpoints.catalog(checkpoint.storageReceipt);
      current = await this.journal.checkpointCataloged(
        current.command.commandId,
        this.now().toISOString(),
      );
    }
    return current;
  }

  #requiredHandle(record: HostExecutionRecord): WorkerTurnHandle {
    if (record.handle === undefined) {
      throw new Error("Host execution record has no worker turn handle.");
    }
    return record.handle;
  }
}
