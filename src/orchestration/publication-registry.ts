import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { workProductIdentitySchema } from "../adjudication/receipts.js";
import type { DraftPublicationReceipt } from "../publication/draft-publisher.js";
import type { PublicationPlan } from "../publication/policy.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";

const draftPublicationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  branch: z.string().min(1),
  head: z.string().regex(/^[0-9a-f]{40}$/u),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.url(),
  draft: z.literal(true),
  publishedAt: z.iso.datetime(),
  tokenExpiresAt: z.iso.datetime(),
});

export type PublicationStage = "planned" | "published" | "blocked";

export interface PublicationState {
  readonly plan: PublicationPlan;
  readonly stage: PublicationStage;
  readonly receipt?: DraftPublicationReceipt;
  readonly reason?: string;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonEqual(left, right);
}

export function initializePublication(
  current: PublicationState | null,
  plan: PublicationPlan,
): PublicationState {
  if (
    !plan.allowed ||
    (plan.action !== "create-draft" && plan.action !== "update-draft") ||
    plan.reasons.length !== 0 ||
    plan.repository === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(plan.repository) ||
    plan.title === undefined ||
    plan.branch === undefined ||
    plan.head === undefined ||
    !/^[0-9a-f]{40}$/u.test(plan.head) ||
    plan.body === undefined ||
    !plan.body.startsWith("(AI Generated).\n\n") ||
    plan.workProduct === undefined ||
    plan.workProduct.checkpointReference.length !== 64
  ) {
    throw new Error("Publication registry requires one complete admitted draft plan.");
  }
  const workProduct = workProductIdentitySchema.parse(plan.workProduct);
  if (
    plan.repository !==
      `${workProduct.repository.owner}/${workProduct.repository.name}` ||
    plan.branch !== workProduct.branch ||
    plan.head !== workProduct.head ||
    (plan.action === "update-draft" &&
      (plan.pullRequestNumber === undefined ||
        plan.expectedRemoteHead === undefined))
  ) {
    throw new Error("Publication plan does not match its exact work product.");
  }
  if (current !== null) {
    if (!same(current.plan, plan)) {
      throw new Error("Publication key already contains another plan.");
    }
    return current;
  }
  return { plan, stage: "planned" };
}

export function recordPublication(
  current: PublicationState,
  rawReceipt: DraftPublicationReceipt,
): PublicationState {
  const receipt = draftPublicationReceiptSchema.parse(rawReceipt);
  if (current.stage === "blocked") {
    throw new Error("Blocked publication cannot be recorded as published.");
  }
  if (current.receipt !== undefined) {
    if (!same(current.receipt, receipt)) {
      throw new Error("Publication already contains another receipt.");
    }
    return current;
  }
  const workProduct = current.plan.workProduct;
  const expectedUrl = `https://github.com/${receipt.repository}/pull/${receipt.pullRequestNumber.toLocaleString("en-US", { useGrouping: false })}`;
  if (
    workProduct === undefined ||
    receipt.repository !== current.plan.repository ||
    receipt.checkpointReference !== workProduct.checkpointReference ||
    receipt.branch !== current.plan.branch ||
    receipt.head !== current.plan.head ||
    receipt.pullRequestUrl !== expectedUrl ||
    Date.parse(receipt.tokenExpiresAt) <= Date.parse(receipt.publishedAt)
  ) {
    throw new Error("Publication receipt does not match its admitted plan.");
  }
  return { ...current, stage: "published", receipt };
}

export function blockPublication(
  current: PublicationState,
  reason: string,
): PublicationState {
  if (reason.trim() === "") {
    throw new Error("Blocked publication requires a reason.");
  }
  if (current.stage === "published") {
    throw new Error("Published work cannot be marked blocked.");
  }
  if (current.stage === "blocked") {
    if (current.reason !== reason) {
      throw new Error("Publication already records another blocker.");
    }
    return current;
  }
  return { ...current, stage: "blocked", reason };
}

interface PublicationRegistryState {
  state: PublicationState;
}

function terminal(error: unknown): never {
  throw new restate.TerminalError(
    error instanceof Error ? error.message : String(error),
  );
}

export const publicationRegistry = restate.object({
  name: "PublicationRegistry",
  options: { ingressPrivate: true },
  handlers: {
    initialize: async (
      ctx: restate.ObjectContext<PublicationRegistryState>,
      plan: PublicationPlan,
    ): Promise<PublicationState> => {
      try {
        const next = initializePublication(await ctx.get("state"), plan);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    record: async (
      ctx: restate.ObjectContext<PublicationRegistryState>,
      receipt: DraftPublicationReceipt,
    ): Promise<PublicationState> => {
      const current = await ctx.get("state");
      if (current === null) {
        throw new restate.TerminalError("Publication is not initialized.");
      }
      try {
        const next = recordPublication(current, receipt);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    block: async (
      ctx: restate.ObjectContext<PublicationRegistryState>,
      reason: string,
    ): Promise<PublicationState> => {
      const current = await ctx.get("state");
      if (current === null) {
        throw new restate.TerminalError("Publication is not initialized.");
      }
      try {
        const next = blockPublication(current, reason);
        ctx.set("state", next);
        return next;
      } catch (error) {
        return terminal(error);
      }
    },
    read: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<PublicationRegistryState>) =>
        await ctx.get("state"),
    ),
  },
});
