import path from "node:path";
import { z } from "zod";
import type { SignedCheckpointStorageReceipt } from "../checkpoints/receipt.js";
import {
  signedCheckpointStorageReceiptSchema,
  verifyCheckpointStorageReceipt,
} from "../checkpoints/receipt.js";
import { dispatchClaimSchema } from "../domain/schemas.js";
import type {
  ClaimTransferRequest,
  DispatchClaim,
  HostLane,
  HostRecord,
} from "../domain/types.js";
import type { CustodyRestoreRequirement } from "../execution/restore.js";
import {
  decideCustody,
  validateCheckpointForResume,
  type CustodyDecision,
} from "../policy/custody.js";

const HOST_HEARTBEAT_MAX_AGE_SECONDS = 120;

const hostRecordSchema = z.object({
  id: z.string().min(1),
  lane: z.enum(["linux", "macos"]),
  online: z.boolean(),
  lastHeartbeatAt: z.iso.datetime(),
  activeClaims: z.array(z.string().min(1)),
  accountIds: z.array(z.string().min(1)),
});

export interface CustodyTransferPlanningInput {
  readonly schemaVersion: 1;
  readonly claim: DispatchClaim;
  readonly requiredLane: HostLane;
  readonly hosts: readonly HostRecord[];
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly checkpointReceipt?: SignedCheckpointStorageReceipt | undefined;
  readonly checkpointReceiptPublicKeyPem?: string | undefined;
  readonly now: string;
}

const custodyTransferPlanningInputSchema: z.ZodType<CustodyTransferPlanningInput> = z.object({
  schemaVersion: z.literal(1),
  claim: dispatchClaimSchema,
  requiredLane: z.enum(["linux", "macos"]),
  hosts: z.array(hostRecordSchema).min(1),
  workspaceRoots: z.record(
    z.string().min(1),
    z.string().refine(
      (value) =>
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        value !== path.parse(value).root,
      { message: "must be one normalized non-root absolute path" },
    ),
  ),
  checkpointReceipt: signedCheckpointStorageReceiptSchema.optional(),
  checkpointReceiptPublicKeyPem: z.string().includes("BEGIN PUBLIC KEY").optional(),
  now: z.iso.datetime(),
}).strict();

export function parseCustodyTransferPlanningInput(
  value: unknown,
): CustodyTransferPlanningInput {
  return custodyTransferPlanningInputSchema.parse(value);
}

export type CustodyTransferPlan =
  | {
      readonly status: "unchanged";
      readonly decision: CustodyDecision;
    }
  | {
      readonly status: "blocked";
      readonly decision: CustodyDecision;
      readonly reason: string;
    }
  | {
      readonly status: "ready";
      readonly decision: CustodyDecision;
      readonly transfer: ClaimTransferRequest;
      readonly nextClaim: DispatchClaim;
      readonly restore: CustodyRestoreRequirement;
    };

function observedHost(host: HostRecord, now: string): HostRecord {
  const ageSeconds = (Date.parse(now) - Date.parse(host.lastHeartbeatAt)) / 1_000;
  return {
    ...host,
    online:
      host.online &&
      Number.isFinite(ageSeconds) &&
      ageSeconds >= 0 &&
      ageSeconds <= HOST_HEARTBEAT_MAX_AGE_SECONDS,
  };
}

function destinationWorktree(input: {
  readonly root: string;
  readonly claim: DispatchClaim;
}): string {
  const suffix = input.claim.issueNumber.toLocaleString("en-US", {
    useGrouping: false,
  });
  return path.join(input.root, `${input.claim.repository.name}-issue-${suffix}`);
}

export function planCustodyTransfer(
  input: CustodyTransferPlanningInput,
): CustodyTransferPlan {
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new Error("Custody transfer time is invalid.");
  }
  const hosts = input.hosts.map((host) => observedHost(host, input.now));
  const sourceHost = hosts.find((host) => host.id === input.claim.hostId);
  if (sourceHost === undefined) {
    return {
      status: "blocked",
      decision: { action: "none", offlineSeconds: 0 },
      reason: "source-host-missing",
    };
  }
  const decision = decideCustody({
    claim: input.claim,
    sourceHost,
    hosts,
    requiredLane: input.requiredLane,
    now: input.now,
  });
  if (decision.action === "none" || decision.action.startsWith("alert-")) {
    return { status: "unchanged", decision };
  }
  if (decision.action === "block-no-host") {
    return { status: "blocked", decision, reason: "compatible-host-unavailable" };
  }

  const destinationHostId = decision.destinationHostId;
  const nextCustodyEpoch = decision.nextCustodyEpoch;
  if (destinationHostId === undefined || nextCustodyEpoch === undefined) {
    return { status: "blocked", decision, reason: "transfer-decision-incomplete" };
  }
  const workspaceRoot = input.workspaceRoots[destinationHostId];
  if (
    workspaceRoot === undefined ||
    !path.isAbsolute(workspaceRoot) ||
    path.normalize(workspaceRoot) !== workspaceRoot ||
    workspaceRoot === path.parse(workspaceRoot).root
  ) {
    return { status: "blocked", decision, reason: "destination-workspace-root-missing" };
  }
  if (
    input.checkpointReceipt === undefined ||
    input.checkpointReceiptPublicKeyPem === undefined
  ) {
    return { status: "blocked", decision, reason: "verified-checkpoint-required" };
  }

  let checkpoint: SignedCheckpointStorageReceipt;
  try {
    checkpoint = verifyCheckpointStorageReceipt({
      receipt: input.checkpointReceipt,
      publicKeyPem: input.checkpointReceiptPublicKeyPem,
    });
  } catch {
    return { status: "blocked", decision, reason: "checkpoint-receipt-invalid" };
  }
  const validity = validateCheckpointForResume({
    checkpoint: checkpoint.manifest,
    claim: input.claim,
    expectedEpoch: nextCustodyEpoch,
  });
  if (!validity.valid) {
    return { status: "blocked", decision, reason: validity.reason };
  }
  const claimedAtMs = Date.parse(input.claim.claimedAt);
  const createdAtMs = Date.parse(checkpoint.manifest.createdAt);
  const storedAtMs = Date.parse(checkpoint.storedAt);
  const nowMs = Date.parse(input.now);
  if (
    checkpoint.hostId !== input.claim.hostId ||
    !Number.isFinite(claimedAtMs) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(storedAtMs) ||
    createdAtMs < claimedAtMs ||
    storedAtMs < createdAtMs ||
    storedAtMs > nowMs
  ) {
    return { status: "blocked", decision, reason: "checkpoint-custody-time-mismatch" };
  }

  const worktree = destinationWorktree({ root: workspaceRoot, claim: input.claim });
  const workerId = `worker-${destinationHostId}`;
  const transfer: ClaimTransferRequest = {
    claimId: input.claim.claimId,
    priorEpoch: input.claim.custodyEpoch,
    nextEpoch: nextCustodyEpoch,
    destinationHostId,
    destinationWorkerId: workerId,
    destinationWorktree: worktree,
    transferredAt: input.now,
  };
  const nextClaim: DispatchClaim = {
    ...input.claim,
    custodyEpoch: nextCustodyEpoch,
    hostId: destinationHostId,
    workerId,
    worktree,
    claimedAt: input.now,
  };
  const restore: CustodyRestoreRequirement = {
    schemaVersion: 1,
    repository: input.claim.repository,
    issueNumber: input.claim.issueNumber,
    claimId: input.claim.claimId,
    priorCustodyEpoch: input.claim.custodyEpoch,
    custodyEpoch: nextCustodyEpoch,
    destinationHostId,
    destinationWorkerId: workerId,
    destinationWorktree: worktree,
    branch: input.claim.branch,
    conflictDomains: [...input.claim.conflictDomains],
    claimedAt: input.now,
    checkpointReference: checkpoint.reference,
    checkpointContentLength: checkpoint.contentLength,
    checkpointBaseHead: checkpoint.manifest.baseHead,
    requiredAt: input.now,
  };
  return {
    status: "ready",
    decision,
    transfer,
    nextClaim,
    restore,
  };
}
