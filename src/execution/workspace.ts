import { createHash } from "node:crypto";
import { z } from "zod";
import { qualificationReportSchema } from "../domain/schemas.js";
import { canonicalJson } from "../security/canonical-json.js";

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

const initialWorkspaceBindingSchema = z.object({
  schemaVersion: z.literal(1),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.literal(1),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  worktree: z.string().startsWith("/"),
  branch: z.string().min(1),
  conflictDomains: z.array(z.string().min(1)).min(1),
  claimedAt: z.iso.datetime(),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  target: z.enum(["shared", "desktop", "pwa", "website"]),
  handoff: z.object({
    qualification: qualificationReportSchema,
    authorityTaskId: z.string().min(1),
    authorityTaskRevision: z.number().int().positive(),
    accountId: z.string().min(1),
    driverId: z.string().min(1),
    publicationCeiling: z.literal("draft-pr"),
    finalizationNonce: z.uuid(),
  }),
});

function addBindingIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function refineInitialWorkspaceBinding(
  binding: z.infer<typeof initialWorkspaceBindingSchema>,
  context: z.RefinementCtx,
): void {
  const qualification = binding.handoff.qualification;
  if (
    qualification.repository.owner !== binding.repository.owner ||
    qualification.repository.name !== binding.repository.name ||
    qualification.repository.defaultBranch !==
      binding.repository.defaultBranch ||
    qualification.issue.number !== binding.issueNumber
  ) {
    addBindingIssue(context, "Workspace handoff changes the qualified issue.");
  }
  if (!qualification.eligible) {
    addBindingIssue(
      context,
      "Workspace handoff requires eligible qualification.",
    );
  }
  const qualifiedDomains = [...qualification.conflictDomains].sort();
  const claimedDomains = [...binding.conflictDomains].sort();
  if (JSON.stringify(qualifiedDomains) !== JSON.stringify(claimedDomains)) {
    addBindingIssue(
      context,
      "Workspace handoff changes qualified conflict domains.",
    );
  }
  if ((qualification.evidence.ownedPaths ?? []).length === 0) {
    addBindingIssue(
      context,
      "Workspace handoff requires qualified owned paths.",
    );
  }
}

export const initialWorkspaceHandoffBindingSchema =
  initialWorkspaceBindingSchema.superRefine(refineInitialWorkspaceBinding);

export type InitialWorkspaceHandoffBinding = z.infer<
  typeof initialWorkspaceHandoffBindingSchema
>;

export const initialWorkspaceRequirementSchema = initialWorkspaceBindingSchema
  .extend({
    requiredAt: z.iso.datetime(),
  })
  .superRefine(refineInitialWorkspaceBinding);

export type InitialWorkspaceRequirement = z.infer<
  typeof initialWorkspaceRequirementSchema
>;

export const initialWorkspaceReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  claimId: z.string().min(1),
  custodyEpoch: z.literal(1),
  hostId: z.string().min(1),
  worktree: z.string().startsWith("/"),
  branch: z.string().min(1),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  preparedAt: z.iso.datetime(),
});

export type InitialWorkspaceReceipt = z.infer<
  typeof initialWorkspaceReceiptSchema
>;

export interface InitialWorkspaceState {
  readonly requirement: InitialWorkspaceRequirement;
  readonly stage: "pending" | "prepared";
  readonly receipt?: InitialWorkspaceReceipt;
}

export interface InitialWorkspacePreparer {
  prepare(
    requirement: InitialWorkspaceRequirement,
  ): Promise<InitialWorkspaceReceipt>;
}

function deterministicUuid(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createWorkspaceFinalizationNonce(input: {
  readonly repository: InitialWorkspaceRequirement["repository"];
  readonly issueNumber: number;
  readonly claimId: string;
  readonly custodyEpoch: 1;
  readonly hostId: string;
  readonly workerId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly authorityTaskId: string;
  readonly authorityTaskRevision: number;
  readonly accountId: string;
  readonly driverId: string;
  readonly baseHead: string;
}): string {
  return deterministicUuid({
    domain: "aubtown.executor-finalization.v1",
    ...input,
  });
}

export function workspaceRequirementFromBinding(input: {
  readonly repository: InitialWorkspaceRequirement["repository"];
  readonly issueNumber: number;
  readonly claimId: string;
  readonly custodyEpoch: 1;
  readonly hostId: string;
  readonly workerId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly conflictDomains: readonly string[];
  readonly claimedAt: string;
  readonly baseHead: string;
  readonly target: InitialWorkspaceRequirement["target"];
  readonly handoff: InitialWorkspaceRequirement["handoff"];
  readonly requiredAt: string;
}): InitialWorkspaceRequirement {
  return initialWorkspaceRequirementSchema.parse({
    schemaVersion: 1,
    ...input,
    conflictDomains: [...input.conflictDomains],
  });
}
