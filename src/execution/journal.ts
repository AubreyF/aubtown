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

const handleSchema: z.ZodType<WorkerTurnHandle> = z.object({
  driverId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  startedAt: z.iso.datetime(),
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
  finishedAt: z.iso.datetime().optional(),
  reportedAt: z.iso.datetime().optional(),
});

export type HostExecutionRecord = z.infer<typeof executionRecordSchema>;

export interface HostExecutionAcceptance {
  readonly record: HostExecutionRecord;
  readonly acceptedNow: boolean;
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
