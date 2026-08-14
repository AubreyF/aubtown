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

export const qualificationCheckSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  blocking: z.boolean(),
  explanation: z.string().min(1),
});

export const qualificationReportSchema = z.object({
  repository: repositoryRefSchema,
  issue: issueRecordSchema,
  evidence: issueEvidenceSchema,
  checks: z.array(qualificationCheckSchema),
  eligible: z.boolean(),
  priorityScore: z.number().finite(),
  conflictDomains: z.array(z.string().min(1)),
  hostLane: z.enum(["linux", "macos"]),
  workLane: z.enum([
    "runtime-neutral",
    "behavioral",
    "provider-visible",
    "integration",
    "release",
    "macos",
    "sensitive",
  ]),
});

export const authorityTaskSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  state: z.string().min(1),
  githubIssue: z.object({
    number: z.number().int().positive(),
    url: z.url(),
  }),
  executionAuthority: z.string().min(1),
  providerAuthority: z.string().min(1),
  behavioral: z.boolean(),
  estimatedMinutes: z.number().int().positive(),
});

export const dispatchClaimSchema = z.object({
  repository: repositoryRefSchema,
  issueNumber: z.number().int().positive(),
  claimId: z.string().min(1),
  custodyEpoch: z.number().int().positive(),
  hostId: z.string().min(1),
  workerId: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  conflictDomains: z.array(z.string().min(1)),
  claimedAt: z.iso.datetime(),
});

export const accountUsageSnapshotSchema = z.object({
  accountId: z.string().min(1),
  observedAt: z.iso.datetime(),
  primary: z.object({
    usedPercent: z.number().min(0).max(100),
    windowDurationMinutes: z.number().int().positive(),
    resetsAt: z.iso.datetime(),
  }),
  dailyBaseline: z.object({
    observedAt: z.iso.datetime(),
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.iso.datetime(),
  }),
  dailyConsumption: z.object({
    day: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u),
    baselineLifetimeTokens: z.number().int().nonnegative().safe(),
    observedLifetimeTokens: z.number().int().nonnegative().safe(),
    grossUsedPercent: z.number().min(0),
    meterState: z.enum(["coherent", "diverged"]),
  }),
  activeTurnIds: z.array(z.string()),
});
