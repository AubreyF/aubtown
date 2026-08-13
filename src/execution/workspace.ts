import { z } from "zod";

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const initialWorkspaceRequirementSchema = z.object({
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
  requiredAt: z.iso.datetime(),
});

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
