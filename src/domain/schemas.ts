import { z } from "zod";

export const repositoryRefSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const issueRecordSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()).default([]),
  state: z.enum(["open", "closed"]),
  updatedAt: z.iso.datetime(),
});

export const issueEvidenceSchema = z.object({
  rootCause: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  validation: z.array(z.string().min(1)).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
  ownedPaths: z.array(z.string().min(1)).optional(),
  logicalLocks: z.array(z.string().min(1)).optional(),
  hostLane: z.enum(["linux", "macos"]).optional(),
  lane: z
    .enum([
      "runtime-neutral",
      "behavioral",
      "provider-visible",
      "integration",
      "release",
      "macos",
      "sensitive",
    ])
    .optional(),
  providerNames: z.array(z.string().min(1)).optional(),
  requiresOwnerReview: z.boolean().optional(),
  behavioral: z.boolean().optional(),
  releaseOrMigrationRisk: z.boolean().optional(),
  duplicateOf: z.number().int().positive().optional(),
});

export const shadowIssueSchema = z.object({
  issue: issueRecordSchema,
  evidence: issueEvidenceSchema,
});

export const shadowInputSchema = z.object({
  repository: repositoryRefSchema,
  issues: z.array(shadowIssueSchema),
});
