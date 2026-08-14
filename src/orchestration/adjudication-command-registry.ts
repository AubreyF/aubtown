import * as restate from "@restatedev/restate-sdk";
import {
  assertAdjudicationCommand,
  sameAdjudicationCommand,
  type AdjudicationCommand,
} from "../adjudication/command.js";

export type AdjudicationCommandStage = "active" | "ready" | "blocked";

export interface AdjudicationCommandState {
  readonly command: AdjudicationCommand;
  readonly stage: AdjudicationCommandStage;
  readonly finishedAt?: string;
}

interface RegistryState {
  command: AdjudicationCommandState;
}

export const adjudicationCommandRegistry = restate.object({
  name: "AdjudicationCommandRegistry",
  options: { ingressPrivate: true },
  handlers: {
    enqueue: async (
      ctx: restate.ObjectContext<RegistryState>,
      rawCommand: AdjudicationCommand,
    ): Promise<AdjudicationCommandState> => {
      const command = assertAdjudicationCommand(rawCommand, ctx.key);
      const current = await ctx.get("command");
      if (current !== null && sameAdjudicationCommand(current.command, command)) {
        return current;
      }
      if (current !== null && current.stage === "active") {
        throw new restate.TerminalError(
          "Host already has another active adjudication command.",
        );
      }
      const next: AdjudicationCommandState = { command, stage: "active" };
      ctx.set("command", next);
      return next;
    },
    finish: async (
      ctx: restate.ObjectContext<RegistryState>,
      input: {
        readonly commandId: string;
        readonly checkpointReference: string;
        readonly stage: "ready" | "blocked";
        readonly finishedAt: string;
      },
    ): Promise<AdjudicationCommandState> => {
      const current = await ctx.get("command");
      if (
        current === null ||
        current.command.commandId !== input.commandId ||
        current.command.workProduct.checkpointReference !==
          input.checkpointReference
      ) {
        throw new restate.TerminalError(
          "Adjudication completion does not match the current command.",
        );
      }
      if (current.stage !== "active") {
        if (current.stage !== input.stage) {
          throw new restate.TerminalError(
            "Adjudication command already records another terminal stage.",
          );
        }
        return current;
      }
      const next: AdjudicationCommandState = {
        ...current,
        stage: input.stage,
        finishedAt: input.finishedAt,
      };
      ctx.set("command", next);
      return next;
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<RegistryState>) =>
        await ctx.get("command"),
    ),
  },
});
