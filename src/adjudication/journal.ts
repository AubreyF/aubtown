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
import { adjudicationCommandSchema } from "./command.js";
import {
  exactValidationReceiptSchema,
  independentReviewReceiptSchema,
} from "./receipts.js";

const reviewHandleSchema = z.object({
  driverId: z.literal("codex-app-server-review-v1"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  startedAt: z.iso.datetime(),
  workProduct: adjudicationCommandSchema.shape.workProduct,
});

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  command: adjudicationCommandSchema,
  action: z.enum(["validate", "review"]),
  stage: z.enum([
    "accepted",
    "validation-starting",
    "validated",
    "validation-reported",
    "review-starting",
    "review-started",
    "reviewed",
    "complete",
    "failed",
  ]),
  acceptedAt: z.iso.datetime(),
  validation: exactValidationReceiptSchema.optional(),
  validationReportedAt: z.iso.datetime().optional(),
  reviewHandle: reviewHandleSchema.optional(),
  review: independentReviewReceiptSchema.optional(),
  reviewReportedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  failure: z.string().min(1).optional(),
});

export type HostAdjudicationRecord = z.infer<typeof recordSchema>;
export type HostReviewHandle = z.infer<typeof reviewHandleSchema>;

const TERMINAL = new Set<HostAdjudicationRecord["stage"]>([
  "complete",
  "failed",
]);

export class HostAdjudicationJournal {
  #pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) {
      throw new Error("Host adjudication journal file must be absolute.");
    }
  }

  read(): Promise<HostAdjudicationRecord | null> {
    return this.#serialize(async () => await this.#read());
  }

  accept(
    command: unknown,
    action: "validate" | "review",
    acceptedAt: string,
  ): Promise<{ readonly record: HostAdjudicationRecord; readonly acceptedNow: boolean }> {
    return this.#serialize(async () => {
      const parsed = adjudicationCommandSchema.parse(command);
      const current = await this.#read();
      if (current?.command.commandId === parsed.commandId) {
        return { record: current, acceptedNow: false };
      }
      if (current !== null && !TERMINAL.has(current.stage)) {
        throw new Error("Host already has another active adjudication command.");
      }
      const next = recordSchema.parse({
        schemaVersion: 1,
        command: parsed,
        action,
        stage: "accepted",
        acceptedAt,
      });
      await this.#write(next);
      return { record: next, acceptedNow: true };
    });
  }

  transition(
    commandId: string,
    update: (current: HostAdjudicationRecord) => HostAdjudicationRecord,
  ): Promise<HostAdjudicationRecord> {
    return this.#serialize(async () => {
      const current = await this.#required(commandId);
      const next = recordSchema.parse(update(current));
      if (next.command.commandId !== current.command.commandId) {
        throw new Error("Adjudication journal transition changed command identity.");
      }
      await this.#write(next);
      return next;
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }

  async #required(commandId: string): Promise<HostAdjudicationRecord> {
    const current = await this.#read();
    if (current === null || current.command.commandId !== commandId) {
      throw new Error("Host adjudication journal does not contain the command.");
    }
    return current;
  }

  async #read(): Promise<HostAdjudicationRecord | null> {
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2 * 1024 * 1024) {
        throw new Error("Host adjudication journal must be a small physical file.");
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new Error(
          "Host adjudication journal cannot be accessible by group or other users.",
        );
      }
      return recordSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async #write(record: HostAdjudicationRecord): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Host adjudication journal parent must be a physical directory.");
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
