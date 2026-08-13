import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  assertExecutorStartCommand,
  executorCommandReceiptSchema,
  type ExecutorCommandReceipt,
  type ExecutorStartCommand,
} from "../execution/command.js";

export type ExecutorCommandStage =
  | "pending"
  | "offered"
  | "started"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled";

export interface ExecutorCommandState {
  readonly command: ExecutorStartCommand;
  readonly stage: ExecutorCommandStage;
  readonly offeredAt?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly finishedAt?: string;
  readonly reason?: string;
}

export interface ExecutorTransferFence {
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly preparedAt: string;
}

const executorTransferFenceSchema = z.object({
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  preparedAt: z.iso.datetime(),
});

const executorTransferReleaseSchema = executorTransferFenceSchema.pick({
  claimId: true,
  custodyEpoch: true,
});

interface RegistryState {
  command: ExecutorCommandState;
  transferFence: ExecutorTransferFence;
}

const TERMINAL_STAGES = new Set<ExecutorCommandStage>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export const executorCommandRegistry = restate.object({
  name: "ExecutorCommandRegistry",
  options: { ingressPrivate: true },
  handlers: {
    enqueue: async (
      ctx: restate.ObjectContext<RegistryState>,
      rawCommand: ExecutorStartCommand,
    ): Promise<ExecutorCommandState> => {
      const command = assertExecutorStartCommand(rawCommand, ctx.key);
      const transferFence = await ctx.get("transferFence");
      if (
        transferFence !== null &&
        transferFence.claimId === command.claim.claimId &&
        transferFence.custodyEpoch === command.claim.custodyEpoch
      ) {
        throw new restate.TerminalError(
          "Executor claim is fenced for custody transfer.",
        );
      }
      const current = await ctx.get("command");
      if (current !== null && current.command.commandId === command.commandId) {
        return current;
      }
      if (current !== null && !TERMINAL_STAGES.has(current.stage)) {
        throw new restate.TerminalError(
          "Executor already has a nonterminal command.",
        );
      }
      const state: ExecutorCommandState = { command, stage: "pending" };
      ctx.set("command", state);
      return state;
    },
    prepareTransfer: async (
      ctx: restate.ObjectContext<RegistryState>,
      rawRequest: ExecutorTransferFence,
    ): Promise<ExecutorTransferFence> => {
      const requested = executorTransferFenceSchema.parse(rawRequest);
      const existing = await ctx.get("transferFence");
      if (existing !== null) {
        if (
          existing.claimId === requested.claimId &&
          existing.custodyEpoch === requested.custodyEpoch
        ) {
          return existing;
        }
        throw new restate.TerminalError(
          "Executor host already has another custody transfer fence.",
        );
      }
      const current = await ctx.get("command");
      if (
        current !== null &&
        current.command.claim.claimId === requested.claimId
      ) {
        if (current.stage === "offered" || current.stage === "started") {
          throw new restate.TerminalError(
            "Executor command must finish or be interrupted before custody transfer.",
          );
        }
        if (current.stage === "pending") {
          ctx.set("command", {
            ...current,
            stage: "cancelled",
            finishedAt: requested.preparedAt,
            reason: "Claim custody transfer prepared before command offer.",
          });
        }
      }
      ctx.set("transferFence", requested);
      return requested;
    },
    releaseTransfer: async (
      ctx: restate.ObjectContext<RegistryState>,
      rawExpected: Pick<ExecutorTransferFence, "claimId" | "custodyEpoch">,
    ): Promise<boolean> => {
      const expected = executorTransferReleaseSchema.parse(rawExpected);
      const existing = await ctx.get("transferFence");
      if (existing === null) {
        return false;
      }
      if (
        existing.claimId !== expected.claimId ||
        existing.custodyEpoch !== expected.custodyEpoch
      ) {
        throw new restate.TerminalError(
          "Only the fenced custody transfer may release the executor host.",
        );
      }
      ctx.clear("transferFence");
      return true;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<RegistryState>) =>
        await ctx.get("command"),
    ),
    offer: async (
      ctx: restate.ObjectContext<RegistryState>,
      input: { readonly commandId: string; readonly offeredAt: string },
    ): Promise<ExecutorCommandState> => {
      const current = await ctx.get("command");
      if (current === null || current.command.commandId !== input.commandId) {
        throw new restate.TerminalError("Executor command is no longer current.");
      }
      if (current.stage === "offered") {
        return current;
      }
      if (current.stage !== "pending") {
        throw new restate.TerminalError("Executor command cannot be offered from its current stage.");
      }
      const next: ExecutorCommandState = {
        ...current,
        stage: "offered",
        offeredAt: input.offeredAt,
      };
      ctx.set("command", next);
      return next;
    },
    cancel: async (
      ctx: restate.ObjectContext<RegistryState>,
      input: {
        readonly commandId: string;
        readonly cancelledAt: string;
        readonly reason: string;
      },
    ): Promise<ExecutorCommandState> => {
      const current = await ctx.get("command");
      if (current === null || current.command.commandId !== input.commandId) {
        throw new restate.TerminalError("Executor command is no longer current.");
      }
      if (TERMINAL_STAGES.has(current.stage)) {
        return current;
      }
      if (current.stage === "started") {
        throw new restate.TerminalError("A started executor command must be interrupted.");
      }
      const next: ExecutorCommandState = {
        ...current,
        stage: "cancelled",
        finishedAt: input.cancelledAt,
        reason: input.reason,
      };
      ctx.set("command", next);
      return next;
    },
    record: async (
      ctx: restate.ObjectContext<RegistryState>,
      input: {
        readonly receipt: ExecutorCommandReceipt;
        readonly acceptedAt: string;
      },
    ): Promise<ExecutorCommandState> => {
      const receipt = executorCommandReceiptSchema.parse(input.receipt);
      const current = await ctx.get("command");
      if (current === null || current.command.commandId !== receipt.commandId) {
        throw new restate.TerminalError("Executor receipt does not name the current command.");
      }
      if (
        current.command.claim.claimId !== receipt.claimId ||
        current.command.claim.custodyEpoch !== receipt.custodyEpoch ||
        current.command.accountId !== receipt.accountId
      ) {
        throw new restate.TerminalError("Executor receipt changes command authority.");
      }
      if (receipt.stage === "started") {
        if (current.stage === "started") {
          if (
            current.threadId !== receipt.threadId ||
            current.turnId !== receipt.turnId
          ) {
            throw new restate.TerminalError("Executor start receipt changes the active turn.");
          }
          return current;
        }
        if (current.stage !== "offered") {
          throw new restate.TerminalError("Executor command was not offered before start.");
        }
        const next: ExecutorCommandState = {
          ...current,
          stage: "started",
          threadId: receipt.threadId,
          turnId: receipt.turnId,
        };
        ctx.set("command", next);
        return next;
      }
      if (TERMINAL_STAGES.has(current.stage)) {
        if (
          current.stage === receipt.stage &&
          current.threadId === receipt.threadId &&
          current.turnId === receipt.turnId
        ) {
          return current;
        }
        throw new restate.TerminalError("Executor command already has another terminal result.");
      }
      if (
        current.stage !== "started" ||
        current.threadId !== receipt.threadId ||
        current.turnId !== receipt.turnId
      ) {
        throw new restate.TerminalError("Executor finish receipt does not match the active turn.");
      }
      const next: ExecutorCommandState = {
        ...current,
        stage: receipt.stage,
        finishedAt: input.acceptedAt,
      };
      ctx.set("command", next);
      return next;
    },
  },
});
