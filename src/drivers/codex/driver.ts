import type { RawAccountUsageObservation } from "../../domain/types.js";
import type {
  WorkerDriver,
  WorkerTurnHandle,
  WorkerTurnRequest,
} from "../worker.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexQuotaSource } from "./quota-source.js";

export interface CodexDriverOptions {
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh";
  readonly now?: () => Date;
}

export class CodexDriver implements WorkerDriver {
  readonly id = "codex-app-server-v1";
  readonly capabilities = {
    hostLanes: ["linux", "macos"] as const,
    canInterrupt: true,
    canReadSubscriptionUsage: true,
    publicationCeiling: "draft-pr" as const,
  };
  readonly #quota: CodexQuotaSource;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly options: CodexDriverOptions,
  ) {
    this.#quota = new CodexQuotaSource(client, options.now);
  }

  async readUsage(accountId: string): Promise<RawAccountUsageObservation> {
    return await this.#quota.read(accountId, []);
  }

  async start(request: WorkerTurnRequest): Promise<WorkerTurnHandle> {
    if (!request.qualification.eligible) {
      throw new Error("Codex driver cannot start an ineligible issue.");
    }
    if (request.claim.issueNumber !== request.qualification.issue.number) {
      throw new Error("Codex driver claim does not match the qualified issue.");
    }
    const threadId = await this.client.startThread({
      cwd: request.repositoryRoot,
      model: this.options.model,
    });
    const turnId = await this.client.startTurn({
      threadId,
      prompt: request.prompt,
      cwd: request.repositoryRoot,
      model: this.options.model,
      effort: this.options.effort,
    });
    return {
      driverId: this.id,
      threadId,
      turnId,
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  async wait(
    handle: WorkerTurnHandle,
  ): Promise<"completed" | "interrupted" | "failed"> {
    return await this.client.waitForTurn(handle);
  }

  async recover(
    handle: WorkerTurnHandle,
    repositoryRoot: string,
  ): Promise<"running" | "completed" | "interrupted" | "failed"> {
    if (handle.driverId !== this.id) {
      throw new Error("Codex driver cannot recover another driver's turn.");
    }
    return await this.client.recoverTurn({
      threadId: handle.threadId,
      turnId: handle.turnId,
      cwd: repositoryRoot,
      model: this.options.model,
    });
  }

  async interrupt(handle: WorkerTurnHandle): Promise<void> {
    await this.client.interrupt(handle.threadId, handle.turnId);
  }
}
