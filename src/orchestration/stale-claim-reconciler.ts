import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FreedClaimListReceipt,
  FreedClaimReleaseReceipt,
  FreedClaimReleaseRequest,
} from "../adapters/freed/claim-broker.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";

export const ACTIVE_CLAIM_HEARTBEAT_MAX_AGE_SECONDS = 120;
export const INITIAL_CLAIM_GRACE_SECONDS = 300;

export interface StaleClaimBroker {
  list(request: { readonly schemaVersion: 1 }): Promise<FreedClaimListReceipt>;
  release(request: FreedClaimReleaseRequest): Promise<FreedClaimReleaseReceipt>;
}

export interface StaleClaimReconciliationResult {
  readonly schemaVersion: 1;
  readonly reconciledAt: string;
  readonly status: "clear" | "waiting";
  readonly releasedClaimIds: readonly string[];
  readonly freshClaimIds: readonly string[];
  readonly graceClaimIds: readonly string[];
  readonly strandedRunningClaimIds: readonly string[];
  readonly remainingClaimIds: readonly string[];
}

function milliseconds(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return parsed;
}

export async function reconcileStaleFreedClaims(input: {
  readonly broker: StaleClaimBroker;
  readonly now: string;
  readonly operationId?: () => string;
  readonly heartbeatMaxAgeSeconds?: number;
  readonly initialGraceSeconds?: number;
}): Promise<StaleClaimReconciliationResult> {
  const reconciledAt = z.iso.datetime().parse(input.now);
  const nowMs = milliseconds(reconciledAt, "Reconciliation time");
  const heartbeatMaxAgeSeconds =
    input.heartbeatMaxAgeSeconds ?? ACTIVE_CLAIM_HEARTBEAT_MAX_AGE_SECONDS;
  const initialGraceSeconds =
    input.initialGraceSeconds ?? INITIAL_CLAIM_GRACE_SECONDS;
  if (
    !Number.isSafeInteger(heartbeatMaxAgeSeconds) ||
    heartbeatMaxAgeSeconds < 30 ||
    !Number.isSafeInteger(initialGraceSeconds) ||
    initialGraceSeconds < heartbeatMaxAgeSeconds
  ) {
    throw new Error("Stale-claim reconciliation intervals are invalid.");
  }

  const initial = await input.broker.list({ schemaVersion: 1 });
  const releasedClaimIds: string[] = [];
  const freshClaimIds: string[] = [];
  const graceClaimIds: string[] = [];
  const strandedRunningClaimIds: string[] = [];

  for (const entry of initial.claims) {
    const claimedAtMs = milliseconds(entry.claim.claimedAt, "Claim acquisition time");
    const heartbeatAtMs = milliseconds(
      entry.claim.heartbeatAt,
      "Claim heartbeat time",
    );
    if (
      claimedAtMs > nowMs ||
      heartbeatAtMs > nowMs ||
      heartbeatAtMs < claimedAtMs
    ) {
      throw new Error("Freed claim chronology is invalid.");
    }
    const heartbeatAgeSeconds = (nowMs - heartbeatAtMs) / 1_000;
    const claimAgeSeconds = (nowMs - claimedAtMs) / 1_000;
    if (heartbeatAgeSeconds <= heartbeatMaxAgeSeconds) {
      freshClaimIds.push(entry.claim.claimId);
      continue;
    }
    if (entry.claim.executionStage === "running") {
      strandedRunningClaimIds.push(entry.claim.claimId);
      continue;
    }
    if (claimAgeSeconds < initialGraceSeconds) {
      graceClaimIds.push(entry.claim.claimId);
      continue;
    }

    const request: FreedClaimReleaseRequest = {
      schemaVersion: 1,
      operationId: input.operationId?.() ?? randomUUID(),
      taskId: entry.taskId,
      expectedTaskRevision: entry.taskRevision,
      authorityClaimId: entry.claim.claimId,
      bindingDigest: entry.bindingDigest,
      custodyEpoch: entry.claim.custodyEpoch,
      expectedHeartbeatAt: entry.claim.heartbeatAt,
      reason: "reconciled-unlaunched",
      releasedAt: reconciledAt,
    };
    const receipt = await input.broker.release(request);
    const expected: FreedClaimReleaseReceipt = {
      schemaVersion: 1,
      operationId: request.operationId,
      taskId: request.taskId,
      taskRevision: request.expectedTaskRevision,
      authorityClaimId: request.authorityClaimId,
      bindingDigest: request.bindingDigest,
      custodyEpoch: request.custodyEpoch,
      expectedHeartbeatAt: request.expectedHeartbeatAt,
      reason: request.reason,
      releasedAt: request.releasedAt,
    };
    if (!canonicalJsonEqual(receipt, expected)) {
      throw new Error("Freed stale-claim release receipt changed the exact claim.");
    }
    releasedClaimIds.push(entry.claim.claimId);
  }

  const final = await input.broker.list({ schemaVersion: 1 });
  const remainingClaimIds = final.claims.map((entry) => entry.claim.claimId);
  if (
    releasedClaimIds.some((claimId) => remainingClaimIds.includes(claimId))
  ) {
    throw new Error("A released Freed claim remains active after reconciliation.");
  }
  return {
    schemaVersion: 1,
    reconciledAt,
    status: remainingClaimIds.length === 0 ? "clear" : "waiting",
    releasedClaimIds: releasedClaimIds.sort(),
    freshClaimIds: freshClaimIds.sort(),
    graceClaimIds: graceClaimIds.sort(),
    strandedRunningClaimIds: strandedRunningClaimIds.sort(),
    remainingClaimIds: remainingClaimIds.sort(),
  };
}
