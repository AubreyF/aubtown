import { z } from "zod";

const repositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const custodyRestoreRequirementSchema = z.object({
  schemaVersion: z.literal(1),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  priorCustodyEpoch: z.number().int().positive(),
  custodyEpoch: z.number().int().positive(),
  destinationHostId: z.string().min(1),
  destinationWorkerId: z.string().min(1),
  destinationWorktree: z.string().startsWith("/"),
  branch: z.string().min(1),
  conflictDomains: z.array(z.string().min(1)).min(1),
  claimedAt: z.iso.datetime(),
  checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  checkpointContentLength: z.number().int().positive(),
  checkpointBaseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  requiredAt: z.iso.datetime(),
});

export type CustodyRestoreRequirement = z.infer<
  typeof custodyRestoreRequirementSchema
>;

export const custodyRestoreReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  destinationHostId: z.string().min(1),
  destinationWorktree: z.string().startsWith("/"),
  checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  checkpointBaseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  restoredAt: z.iso.datetime(),
});

export type CustodyRestoreReceipt = z.infer<typeof custodyRestoreReceiptSchema>;

export interface CustodyRestoreState {
  readonly requirement: CustodyRestoreRequirement;
  readonly stage: "pending" | "restored";
  readonly receipt?: CustodyRestoreReceipt;
}
