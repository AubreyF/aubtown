import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  executorStartCommandSchema,
  type ExecutorStartCommand,
} from "./command.js";
import type { WorkerTurnHandle } from "../drivers/worker.js";
import { checkpointManifestSchema } from "../checkpoints/codec.js";
import { signedCheckpointStorageReceiptSchema } from "../checkpoints/receipt.js";

const checkpointStateSchema = z.object({
  reference: z.string().regex(/^[0-9a-f]{64}$/u),
  manifest: checkpointManifestSchema,
  storageReceipt: signedCheckpointStorageReceiptSchema.optional(),
  catalogedAt: z.iso.datetime().optional(),
});

const handleSchema: z.ZodType<WorkerTurnHandle> = z.object({
  driverId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  startedAt: z.iso.datetime(),
});

const finalizationStateSchema = z.object({
  nonce: z.uuid(),
  head: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
});

const executionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  command: executorStartCommandSchema,
  stage: z.enum([
    "accepted",
    "started",
    "completed",
    "interrupted",
    "failed",
  ]),
  acceptedAt: z.iso.datetime(),
  handle: handleSchema.optional(),
  finalization: finalizationStateSchema.optional(),
  finishedAt: z.iso.datetime().optional(),
  checkpoint: checkpointStateSchema.optional(),
  reportedAt: z.iso.datetime().optional(),
});

export type HostExecutionRecord = z.infer<typeof executionRecordSchema>;

export interface HostExecutionAcceptance {
  readonly record: HostExecutionRecord;
  readonly acceptedNow: boolean;
}

export interface HostExecutionFinalizationPreparation {
  readonly record: HostExecutionRecord;
  readonly nonce: string;
}

const TERMINAL = new Set<HostExecutionRecord["stage"]>([
  "completed",
  "interrupted",
  "failed",
]);

export class HostExecutionJournal {
  #pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) {
      throw new Error("Host execution journal file must be absolute.");
    }
  }

  read(): Promise<HostExecutionRecord | null> {
    return this.#serialize(async () => await this.#read());
  }

  accept(
    command: ExecutorStartCommand,
    acceptedAt: string,
  ): Promise<HostExecutionAcceptance> {
    return this.#serialize(async () => {
      const parsedCommand = executorStartCommandSchema.parse(command);
      const current = await this.#read();
      if (current !== null && current.command.commandId === parsedCommand.commandId) {
        return { record: current, acceptedNow: false };
      }
      if (current !== null && !TERMINAL.has(current.stage)) {
        throw new Error("Host already has another active execution command.");
      }
      const next = executionRecordSchema.parse({
        schemaVersion: 1,
        command: parsedCommand,
        stage: "accepted",
        acceptedAt,
      });
      await this.#write(next);
      return { record: next, acceptedNow: true };
    });
  }

  started(
    commandId: string,
    handle: WorkerTurnHandle,
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      if (current.stage === "started") {
        if (
          current.handle?.threadId !== handle.threadId ||
          current.handle.turnId !== handle.turnId
        ) {
          throw new Error("Host execution journal already records another turn.");
        }
        return current;
      }
      if (current.stage !== "accepted") {
        throw new Error("Host execution command cannot start from its current stage.");
      }
      const next = executionRecordSchema.parse({
        ...current,
        stage: "started",
        handle,
      });
      await this.#write(next);
      return next;
    });
  }

  prepareFinalization(
    commandId: string,
  ): Promise<HostExecutionFinalizationPreparation> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      if (current.stage !== "started" || current.handle === undefined) {
        throw new Error("Only a started execution can prepare finalization.");
      }
      if (current.finalization !== undefined) {
        return { record: current, nonce: current.finalization.nonce };
      }
      const nonce = randomUUID();
      const next = executionRecordSchema.parse({
        ...current,
        finalization: { nonce },
      });
      await this.#write(next);
      return { record: next, nonce };
    });
  }

  candidateFinalized(
    commandId: string,
    nonce: string,
    head: string,
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      if (current.stage !== "started" || current.handle === undefined) {
        throw new Error("Only a started execution can record finalization.");
      }
      if (current.finalization?.nonce !== nonce) {
        throw new Error("Candidate finalization nonce does not match the journal.");
      }
      if (current.finalization.head !== undefined) {
        if (current.finalization.head !== head) {
          throw new Error("Host execution journal already records another candidate head.");
        }
        return current;
      }
      const next = executionRecordSchema.parse({
        ...current,
        finalization: { nonce, head },
      });
      await this.#write(next);
      return next;
    });
  }

  finish(
    commandId: string,
    stage: "completed" | "interrupted" | "failed",
    finishedAt: string,
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      if (TERMINAL.has(current.stage)) {
        if (current.stage !== stage) {
          throw new Error("Host execution journal already records another result.");
        }
        return current;
      }
      if (current.stage !== "started" || current.handle === undefined) {
        throw new Error("Host execution command has no started turn to finish.");
      }
      const { reportedAt: _reportedAt, ...unreported } = current;
      const next = executionRecordSchema.parse({
        ...unreported,
        stage,
        finishedAt,
      });
      await this.#write(next);
      return next;
    });
  }

  checkpointCaptured(
    commandId: string,
    checkpoint: Pick<NonNullable<HostExecutionRecord["checkpoint"]>, "reference" | "manifest">,
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#requiredTerminal(commandId);
      if (current.checkpoint !== undefined) {
        if (current.checkpoint.reference !== checkpoint.reference) {
          throw new Error("Host execution journal already records another checkpoint.");
        }
        return current;
      }
      const next = executionRecordSchema.parse({ ...current, checkpoint });
      await this.#write(next);
      return next;
    });
  }

  checkpointStored(
    commandId: string,
    storageReceipt: NonNullable<HostExecutionRecord["checkpoint"]>["storageReceipt"],
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#requiredTerminal(commandId);
      if (current.checkpoint === undefined) {
        throw new Error("Host execution journal has no captured checkpoint.");
      }
      if (storageReceipt === undefined) {
        throw new Error("Checkpoint storage receipt is required.");
      }
      if (current.checkpoint.reference !== storageReceipt.reference) {
        throw new Error("Checkpoint storage receipt does not match the journal reference.");
      }
      if (current.checkpoint.storageReceipt !== undefined) {
        return current;
      }
      const next = executionRecordSchema.parse({
        ...current,
        checkpoint: { ...current.checkpoint, storageReceipt },
      });
      await this.#write(next);
      return next;
    });
  }

  checkpointCataloged(
    commandId: string,
    catalogedAt: string,
  ): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#requiredTerminal(commandId);
      if (current.checkpoint?.storageReceipt === undefined) {
        throw new Error("Host execution journal has no stored checkpoint receipt.");
      }
      if (current.checkpoint.catalogedAt !== undefined) {
        return current;
      }
      const next = executionRecordSchema.parse({
        ...current,
        checkpoint: { ...current.checkpoint, catalogedAt },
      });
      await this.#write(next);
      return next;
    });
  }

  reported(commandId: string, reportedAt: string): Promise<HostExecutionRecord> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      if (current.stage === "accepted") {
        throw new Error("An unstarted execution cannot be reported.");
      }
      const next = executionRecordSchema.parse({ ...current, reportedAt });
      await this.#write(next);
      return next;
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }

  async #required(commandId: string): Promise<HostExecutionRecord> {
    const current = await this.#read();
    if (current === null || current.command.commandId !== commandId) {
      throw new Error("Host execution journal does not contain the command.");
    }
    return current;
  }

  async #requiredTerminal(commandId: string): Promise<HostExecutionRecord> {
    const current = await this.#required(commandId);
    if (!TERMINAL.has(current.stage)) {
      throw new Error("Host execution command is not terminal.");
    }
    return current;
  }

  async #read(): Promise<HostExecutionRecord | null> {
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) {
        throw new Error("Host execution journal must be a small physical file.");
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new Error("Host execution journal cannot be accessible by group or other users.");
      }
      return executionRecordSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async #write(record: HostExecutionRecord): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Host execution journal parent must be a physical directory.");
    }
    await chmod(directory, 0o700);
    const temporary = path.join(
      directory,
      `.${path.basename(this.file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "ENOENT"
  );
}
