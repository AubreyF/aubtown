import * as restate from "@restatedev/restate-sdk";
import {
  assessHandoff,
  exactValidationReceiptSchema,
  independentReviewReceiptSchema,
  workProductIdentitySchema,
  type ExactValidationReceipt,
  type IndependentReviewReceipt,
  type WorkProductIdentity,
} from "../adjudication/receipts.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";

export type HandoffStage =
  | "awaiting-validation"
  | "awaiting-review"
  | "ready"
  | "blocked";

export interface HandoffState {
  readonly workProduct: WorkProductIdentity;
  readonly stage: HandoffStage;
  readonly validation?: ExactValidationReceipt;
  readonly review?: IndependentReviewReceipt;
  readonly reasons: readonly string[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonEqual(left, right);
}

export function initializeHandoff(
  current: HandoffState | null,
  rawWorkProduct: WorkProductIdentity,
): HandoffState {
  const workProduct = workProductIdentitySchema.parse(rawWorkProduct);
  if (current !== null) {
    if (!same(current.workProduct, workProduct)) {
      throw new Error("Handoff key already contains another work product.");
    }
    return current;
  }
  return { workProduct, stage: "awaiting-validation", reasons: [] };
}

export function applyValidation(
  current: HandoffState,
  rawValidation: ExactValidationReceipt,
): HandoffState {
  const validation = exactValidationReceiptSchema.parse(rawValidation);
  if (current.validation !== undefined) {
    if (!same(current.validation, validation)) {
      throw new Error("Handoff already contains another validation receipt.");
    }
    return current;
  }
  if (current.stage !== "awaiting-validation") {
    throw new Error("Handoff is not awaiting validation.");
  }
  const assessment = assessHandoff({
    workProduct: current.workProduct,
    validation,
    review: {
      schemaVersion: 1,
      kind: "independent-review",
      workProduct: current.workProduct,
      reviewer: {
        driverId: "pending",
        threadId: "pending-review-thread",
        turnId: "pending-review-turn",
      },
      verdict: "blocked",
      findings: [],
      completedAt: validation.completedAt,
      summary: "Independent review is pending.",
    },
  });
  const validationReasons = assessment.reasons.filter(
    (reason) => !reason.startsWith("review-"),
  );
  return validationReasons.length === 0
    ? {
        ...current,
        validation,
        stage: "awaiting-review",
        reasons: [],
      }
    : {
        ...current,
        validation,
        stage: "blocked",
        reasons: validationReasons,
      };
}

export function applyReview(
  current: HandoffState,
  rawReview: IndependentReviewReceipt,
): HandoffState {
  const review = independentReviewReceiptSchema.parse(rawReview);
  if (current.review !== undefined) {
    if (!same(current.review, review)) {
      throw new Error("Handoff already contains another review receipt.");
    }
    return current;
  }
  if (current.stage !== "awaiting-review" || current.validation === undefined) {
    throw new Error("Handoff is not awaiting independent review.");
  }
  const assessment = assessHandoff({
    workProduct: current.workProduct,
    validation: current.validation,
    review,
  });
  return {
    ...current,
    review,
    stage: assessment.ready ? "ready" : "blocked",
    reasons: assessment.reasons,
  };
}

interface HandoffRegistryState {
  state: HandoffState;
}

function terminal(error: unknown): never {
  throw new restate.TerminalError(
    error instanceof Error ? error.message : String(error),
  );
}

export const handoffRegistry = restate.object({
  name: "HandoffRegistry",
  options: { ingressPrivate: true },
  handlers: {
    initialize: async (
      ctx: restate.ObjectContext<HandoffRegistryState>,
      workProduct: WorkProductIdentity,
    ): Promise<HandoffState> => {
      try {
        const next = initializeHandoff(await ctx.get("state"), workProduct);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    recordValidation: async (
      ctx: restate.ObjectContext<HandoffRegistryState>,
      validation: ExactValidationReceipt,
    ): Promise<HandoffState> => {
      const current = await ctx.get("state");
      if (current === null) {
        throw new restate.TerminalError("Handoff is not initialized.");
      }
      try {
        const next = applyValidation(current, validation);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    recordReview: async (
      ctx: restate.ObjectContext<HandoffRegistryState>,
      review: IndependentReviewReceipt,
    ): Promise<HandoffState> => {
      const current = await ctx.get("state");
      if (current === null) {
        throw new restate.TerminalError("Handoff is not initialized.");
      }
      try {
        const next = applyReview(current, review);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<HandoffRegistryState>) =>
        await ctx.get("state"),
    ),
  },
});
