import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AuthorityTask,
  DispatchClaim,
  QualificationReport,
} from "../domain/types.js";
import {
  authorityTaskSchema,
  dispatchClaimSchema,
  qualificationReportSchema,
} from "../domain/schemas.js";
import { canonicalJson } from "../security/canonical-json.js";

export interface ExecutionAdmission {
  readonly schemaVersion: 1;
  readonly bridgeId: string;
  readonly authorityClaimId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly bindingDigest: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

export const executionAdmissionSchema: z.ZodType<ExecutionAdmission> = z.object({
  schemaVersion: z.literal(1),
  bridgeId: z.string().min(1),
  authorityClaimId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  bindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  authorizedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export interface ExecutionAdmissionBinding {
  readonly qualification: QualificationReport;
  readonly authorityTask: AuthorityTask;
  readonly claim: DispatchClaim;
  readonly accountId: string;
  readonly driverId: string;
  readonly baseHead: string;
  readonly target: "shared" | "desktop" | "pwa" | "website";
}

export const executionAdmissionBindingSchema: z.ZodType<ExecutionAdmissionBinding> =
  z.object({
    qualification: qualificationReportSchema,
    authorityTask: authorityTaskSchema,
    claim: dispatchClaimSchema,
    accountId: z.string().min(1),
    driverId: z.string().min(1),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
    target: z.enum(["shared", "desktop", "pwa", "website"]),
  });

export function createExecutionAdmissionDigest(
  binding: ExecutionAdmissionBinding,
): string {
  return createHash("sha256").update(canonicalJson(binding)).digest("hex");
}

export function assertExecutionAdmission(input: {
  readonly admission: ExecutionAdmission;
  readonly binding: ExecutionAdmissionBinding;
  readonly now: string;
}): ExecutionAdmission {
  const admission = executionAdmissionSchema.parse(input.admission);
  const now = Date.parse(input.now);
  const authorizedAt = Date.parse(admission.authorizedAt);
  const expiresAt = Date.parse(admission.expiresAt);
  if (
    !Number.isFinite(now) ||
    expiresAt <= authorizedAt ||
    now < authorizedAt ||
    now >= expiresAt
  ) {
    throw new Error("Execution authority admission is outside its valid lifetime.");
  }
  if (
    admission.taskId !== input.binding.authorityTask.id ||
    admission.taskRevision !== input.binding.authorityTask.revision
  ) {
    throw new Error("Execution authority admission changes the authority task.");
  }
  if (admission.authorityClaimId !== input.binding.claim.claimId) {
    throw new Error("Execution authority admission changes the task-scoped claim.");
  }
  if (admission.bindingDigest !== createExecutionAdmissionDigest(input.binding)) {
    throw new Error("Execution authority admission does not bind the dispatch.");
  }
  return admission;
}
