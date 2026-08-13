import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

export interface JsonRpcTransport {
  send(message: unknown): Promise<unknown>;
  notify(message: unknown): Promise<void>;
  onNotification(listener: (message: unknown) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<(message: unknown) => void>();
  readonly #requestTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  #nextId = 1;
  #closed = false;

  constructor(options?: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly requestTimeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly onStderr?: (chunk: string) => void;
  }) {
    this.#requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
    this.#closeTimeoutMs = options?.closeTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new Error("Codex app-server request timeout must be a positive integer.");
    }
    if (!Number.isInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new Error("Codex app-server close timeout must be a positive integer.");
    }
    this.#process = spawn(options?.command ?? "codex", options?.args ?? ["app-server"], {
      env: options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.#acceptLine(line));
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      options?.onStderr?.(chunk);
    });
    this.#process.on("error", (error) => this.#rejectAll(error));
    this.#process.on("exit", (code, signal) => {
      this.#rejectAll(
        new Error(`Codex app-server exited with code ${String(code)} and signal ${String(signal)}.`),
      );
    });
  }

  async send(message: unknown): Promise<unknown> {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError("JSON-RPC messages must be objects.");
    }
    if (this.#closed) {
      throw new Error("Codex app-server transport is closed.");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const record = message as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : "unknown";
    const envelope = { ...record, id };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) {
          return;
        }
        reject(
          new Error(
            `Codex app-server request ${method} timed out after ${this.#requestTimeoutMs.toLocaleString()} ms.`,
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#process.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          const pending = this.#pending.get(id);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.#pending.delete(id);
          }
          reject(error);
        }
      });
    });
  }

  async notify(message: unknown): Promise<void> {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError("JSON-RPC messages must be objects.");
    }
    if (this.#closed) {
      throw new Error("Codex app-server transport is closed.");
    }
    await new Promise<void>((resolve, reject) => {
      this.#process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onNotification(listener: (message: unknown) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectAll(new Error("Codex app-server transport closed."));
    if (
      this.#process.exitCode !== null ||
      this.#process.signalCode !== null
    ) {
      return;
    }
    const exited = new Promise<void>((resolve) =>
      this.#process.once("exit", () => resolve()),
    );
    this.#process.kill("SIGTERM");
    const forced = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#process.kill("SIGKILL");
        resolve();
      }, this.#closeTimeoutMs);
      exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await forced;
    if (
      this.#process.exitCode === null &&
      this.#process.signalCode === null
    ) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Codex app-server did not exit after SIGKILL within ${this.#closeTimeoutMs.toLocaleString()} ms.`,
              ),
            ),
          this.#closeTimeoutMs,
        );
        exited.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  #acceptLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const response = value as Record<string, unknown>;
    if (typeof response.id !== "number") {
      for (const listener of this.#notificationListeners) {
        listener(value);
      }
      return;
    }
    if (typeof response.method === "string") {
      this.#rejectServerRequest(response.id, response.method);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) {
      pending.reject(new Error(`Codex app-server error: ${JSON.stringify(response.error)}`));
      return;
    }
    pending.resolve(response.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #rejectServerRequest(id: number, method: string): void {
    this.#process.stdin.write(
      `${JSON.stringify({
        id,
        error: {
          code: -32_601,
          message: `Freedworks does not permit server-initiated method ${method}.`,
        },
      })}\n`,
      (error) => {
        if (error !== null && error !== undefined) {
          this.#rejectAll(error);
        }
      },
    );
  }
}

const rateWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().positive(),
  resetsAt: z.number().int().positive(),
});

const rateLimitBucketSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: rateWindowSchema,
  secondary: rateWindowSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
}).passthrough();

const rateLimitsResponseSchema = z.object({
  rateLimits: rateLimitBucketSchema,
  rateLimitsByLimitId: z.record(z.string(), rateLimitBucketSchema).optional(),
}).passthrough();

const usageResponseSchema = z.object({
  summary: z
    .object({
      lifetimeTokens: z.number().nullable().optional(),
      peakDailyTokens: z.number().nullable().optional(),
    })
    .nullable(),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string(),
        tokens: z.number().nonnegative(),
      }),
    )
    .nullable(),
});

const threadStartResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();

const turnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1),
    status: z.string(),
  }).passthrough(),
}).passthrough();

const modelListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      model: z.string().min(1),
      hidden: z.boolean(),
      supportedReasoningEfforts: z.array(
        z.object({
          reasoningEffort: z.string().min(1),
        }).passthrough(),
      ),
    }).passthrough(),
  ),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

const threadResumeResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    turns: z.array(
      z.object({
        id: z.string().min(1),
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      }).passthrough(),
    ),
  }).passthrough(),
}).passthrough();

export type CodexRateLimits = z.infer<typeof rateLimitsResponseSchema>;
export type CodexUsage = z.infer<typeof usageResponseSchema>;
export type CodexModel = z.infer<typeof modelListResponseSchema>["data"][number];

export class CodexAppServerClient {
  #initialized = false;
  readonly #completedTurns = new Map<string, "completed" | "interrupted" | "failed">();
  readonly #finalMessages = new Map<string, string>();
  readonly #turnWaiters = new Map<
    string,
    Set<(status: "completed" | "interrupted" | "failed") => void>
  >();

  constructor(private readonly transport: JsonRpcTransport) {
    this.transport.onNotification((message) => this.#acceptNotification(message));
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }
    await this.transport.send({
      method: "initialize",
      params: {
        clientInfo: {
          name: "freedworks",
          title: "Freedworks",
          version: "0.1.0",
        },
        capabilities: {},
      },
    });
    await this.transport.notify({ method: "initialized", params: {} });
    this.#initialized = true;
  }

  async readRateLimits(): Promise<CodexRateLimits> {
    await this.initialize();
    return rateLimitsResponseSchema.parse(
      await this.transport.send({ method: "account/rateLimits/read" }),
    );
  }

  async readUsage(): Promise<CodexUsage> {
    await this.initialize();
    return usageResponseSchema.parse(
      await this.transport.send({ method: "account/usage/read" }),
    );
  }

  async listModels(): Promise<readonly CodexModel[]> {
    await this.initialize();
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const response = modelListResponseSchema.parse(
        await this.transport.send({
          method: "model/list",
          params: {
            cursor,
            limit: 100,
            includeHidden: true,
          },
        }),
      );
      models.push(...response.data);
      cursor = response.nextCursor ?? null;
      if (cursor === null) {
        return models;
      }
    }
    throw new Error("Codex model catalog exceeded the pagination safety limit.");
  }

  async assertModelCallable(input: {
    readonly model: string;
    readonly effort: string;
  }): Promise<CodexModel> {
    const advertised = (await this.listModels()).find(
      (candidate) => candidate.model === input.model,
    );
    if (advertised === undefined) {
      throw new Error(`Codex did not advertise ${input.model} as callable.`);
    }
    if (
      !advertised.supportedReasoningEfforts.some(
        (candidate) => candidate.reasoningEffort === input.effort,
      )
    ) {
      throw new Error(
        `Codex model ${input.model} did not advertise reasoning effort ${input.effort}.`,
      );
    }
    return advertised;
  }

  async startThread(input: {
    readonly cwd: string;
    readonly model: string;
    readonly sandbox?: "readOnly" | "workspaceWrite";
  }): Promise<string> {
    await this.initialize();
    const response = threadStartResponseSchema.parse(
      await this.transport.send({
        method: "thread/start",
        params: {
          model: input.model,
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: input.sandbox ?? "workspaceWrite",
          serviceName: "freedworks",
        },
      }),
    );
    return response.thread.id;
  }

  async startTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string;
    readonly effort: "low" | "medium" | "high" | "xhigh";
  }): Promise<string> {
    await this.initialize();
    const response = turnStartResponseSchema.parse(
      await this.transport.send({
        method: "turn/start",
        params: {
          threadId: input.threadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: input.cwd,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [input.cwd],
            networkAccess: true,
          },
          model: input.model,
          effort: input.effort,
          summary: "concise",
        },
      }),
    );
    return response.turn.id;
  }

  async startStructuredReadOnlyTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string;
    readonly effort: "low" | "medium" | "high" | "xhigh";
    readonly outputSchema: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    await this.initialize();
    const response = turnStartResponseSchema.parse(
      await this.transport.send({
        method: "turn/start",
        params: {
          threadId: input.threadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: input.cwd,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          model: input.model,
          effort: input.effort,
          summary: "concise",
          outputSchema: input.outputSchema,
        },
      }),
    );
    return response.turn.id;
  }

  async recoverTurn(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly cwd: string;
    readonly model: string;
  }): Promise<"running" | "completed" | "interrupted" | "failed"> {
    await this.initialize();
    const response = threadResumeResponseSchema.parse(
      await this.transport.send({
        method: "thread/resume",
        params: {
          threadId: input.threadId,
          cwd: input.cwd,
          model: input.model,
          approvalPolicy: "never",
          sandbox: "workspaceWrite",
        },
      }),
    );
    if (response.thread.id !== input.threadId) {
      throw new Error("Codex resumed a different thread.");
    }
    const turn = response.thread.turns.find(
      (candidate) => candidate.id === input.turnId,
    );
    if (turn === undefined) {
      throw new Error("Codex resumed thread does not contain the recorded turn.");
    }
    if (turn.status === "inProgress") {
      return "running";
    }
    this.#completedTurns.set(turn.id, turn.status);
    return turn.status;
  }

  async waitForTurn(input: {
    readonly threadId: string;
    readonly turnId: string;
  }): Promise<"completed" | "interrupted" | "failed"> {
    await this.initialize();
    const completed = this.#completedTurns.get(input.turnId);
    if (completed !== undefined) {
      return completed;
    }
    return await new Promise((resolve) => {
      const waiters = this.#turnWaiters.get(input.turnId) ?? new Set();
      waiters.add(resolve);
      this.#turnWaiters.set(input.turnId, waiters);
    });
  }

  async waitForStructuredOutput(input: {
    readonly threadId: string;
    readonly turnId: string;
  }): Promise<unknown> {
    const status = await this.waitForTurn(input);
    if (status !== "completed") {
      throw new Error(`Structured Codex turn ended with status ${status}.`);
    }
    const message = this.#finalMessages.get(input.turnId);
    if (message === undefined) {
      throw new Error("Structured Codex turn completed without a final agent message.");
    }
    try {
      return JSON.parse(message);
    } catch {
      throw new Error("Structured Codex turn returned invalid JSON.");
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.initialize();
    await this.transport.send({
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  #acceptNotification(message: unknown): void {
    const completedItem = z
      .object({
        method: z.literal("item/completed"),
        params: z.object({
          threadId: z.string(),
          turnId: z.string(),
          item: z.object({
            type: z.literal("agentMessage"),
            text: z.string(),
            phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
          }).passthrough(),
        }).passthrough(),
      })
      .safeParse(message);
    if (
      completedItem.success &&
      completedItem.data.params.item.phase !== "commentary"
    ) {
      this.#finalMessages.set(
        completedItem.data.params.turnId,
        completedItem.data.params.item.text,
      );
    }
    const parsed = z
      .object({
        method: z.literal("turn/completed"),
        params: z.object({
          turn: z.object({
            id: z.string(),
            status: z.enum(["completed", "interrupted", "failed"]),
          }).passthrough(),
        }).passthrough(),
      })
      .safeParse(message);
    if (!parsed.success) {
      return;
    }
    const { id, status } = parsed.data.params.turn;
    this.#completedTurns.set(id, status);
    const waiters = this.#turnWaiters.get(id);
    if (waiters === undefined) {
      return;
    }
    this.#turnWaiters.delete(id);
    for (const resolve of waiters) {
      resolve(status);
    }
  }
}
