import { z } from "zod";
import type { QualificationReport } from "../domain/types.js";
import {
  independentReviewReceiptSchema,
  type IndependentReviewReceipt,
  type WorkProductIdentity,
} from "./receipts.js";
import { CodexAppServerClient } from "../drivers/codex/app-server-client.js";

const structuredReviewSchema = z.object({
  verdict: z.enum(["pass", "changes-requested", "blocked"]),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "high", "medium", "low"]),
      title: z.string().min(1),
      body: z.string().min(1),
      path: z.string().min(1).optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
});

const structuredReviewOutputSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "changes-requested", "blocked"],
    },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "high", "medium", "low"],
          },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
        },
        required: ["severity", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

export interface CodexReviewHandle {
  readonly driverId: "codex-app-server-review-v1";
  readonly threadId: string;
  readonly turnId: string;
  readonly startedAt: string;
  readonly workProduct: WorkProductIdentity;
}

export class CodexIndependentReviewer {
  readonly id = "codex-app-server-review-v1" as const;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly options: {
      readonly model: string;
      readonly effort: "low" | "medium" | "high" | "xhigh";
      readonly now?: () => Date;
    },
  ) {}

  async start(input: {
    readonly workProduct: WorkProductIdentity;
    readonly qualification: QualificationReport;
    readonly repositoryRoot: string;
  }): Promise<CodexReviewHandle> {
    const threadId = await this.client.startThread({
      cwd: input.repositoryRoot,
      model: this.options.model,
      sandbox: "readOnly",
    });
    if (threadId === input.workProduct.implementation.threadId) {
      throw new Error("Codex reviewer reused the implementation thread.");
    }
    const turnId = await this.client.startStructuredReadOnlyTurn({
      threadId,
      prompt: this.#prompt(input),
      cwd: input.repositoryRoot,
      model: this.options.model,
      effort: this.options.effort,
      outputSchema: structuredReviewOutputSchema,
    });
    return {
      driverId: this.id,
      threadId,
      turnId,
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      workProduct: input.workProduct,
    };
  }

  async wait(handle: CodexReviewHandle): Promise<IndependentReviewReceipt> {
    const output = structuredReviewSchema.parse(
      await this.client.waitForStructuredOutput(handle),
    );
    return independentReviewReceiptSchema.parse({
      schemaVersion: 1,
      kind: "independent-review",
      workProduct: handle.workProduct,
      reviewer: {
        driverId: handle.driverId,
        threadId: handle.threadId,
        turnId: handle.turnId,
      },
      verdict: output.verdict,
      findings: output.findings,
      completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      summary: output.summary,
    });
  }

  async recover(
    handle: CodexReviewHandle,
  ): Promise<"running" | "completed" | "interrupted" | "failed"> {
    return await this.client.recoverStructuredTurn({
      threadId: handle.threadId,
      turnId: handle.turnId,
      cwd: handle.workProduct.worktree,
      model: this.options.model,
    });
  }

  #prompt(input: {
    readonly workProduct: WorkProductIdentity;
    readonly qualification: QualificationReport;
  }): string {
    return [
      "Review the current repository worktree without changing it.",
      `The authenticated work product is checkpoint ${input.workProduct.checkpointReference} at Git head ${input.workProduct.head} with patch digest ${input.workProduct.patchDigest}.`,
      `Compare the complete current change against immutable base commit ${input.workProduct.baseHead}.`,
      "Judge correctness, regressions, authority boundaries, security, test adequacy, and the qualified acceptance criteria.",
      `Acceptance criteria: ${JSON.stringify(input.qualification.evidence.acceptanceCriteria ?? [])}`,
      `Required validation: ${JSON.stringify(input.qualification.evidence.validation ?? [])}`,
      "Do not edit files, publish, contact providers, or delegate the review.",
      "Return only the requested structured result.",
    ].join("\n");
  }
}
