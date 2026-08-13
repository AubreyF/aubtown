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
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<(message: unknown) => void>();
  #nextId = 1;

  constructor(options?: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
  }) {
    this.#process = spawn(options?.command ?? "codex", options?.args ?? ["app-server"], {
      env: options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.#acceptLine(line));
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
    const id = this.#nextId;
    this.#nextId += 1;
    const envelope = { ...(message as Record<string, unknown>), id };
    return await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#process.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async notify(message: unknown): Promise<void> {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError("JSON-RPC messages must be objects.");
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
    if (this.#process.exitCode !== null) {
      return;
    }
    this.#process.kill("SIGTERM");
    await new Promise<void>((resolve) => this.#process.once("exit", () => resolve()));
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
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(new Error(`Codex app-server error: ${JSON.stringify(response.error)}`));
      return;
    }
    pending.resolve(response.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
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

export type CodexRateLimits = z.infer<typeof rateLimitsResponseSchema>;
export type CodexUsage = z.infer<typeof usageResponseSchema>;

export class CodexAppServerClient {
  #initialized = false;
  readonly #completedTurns = new Map<string, "completed" | "interrupted" | "failed">();
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

  async startThread(input: {
    readonly cwd: string;
    readonly model: string;
  }): Promise<string> {
    await this.initialize();
    const response = threadStartResponseSchema.parse(
      await this.transport.send({
        method: "thread/start",
        params: {
          model: input.model,
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: "workspaceWrite",
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
