import type {
  CustodyCheckpoint,
  DispatchClaim,
  HostRecord,
  HostLane,
} from "../domain/types.js";

export interface CustodyPolicy {
  readonly firstAlertSeconds: number;
  readonly secondAlertSeconds: number;
  readonly failoverSeconds: number;
}

export const APPROVED_CUSTODY_POLICY: CustodyPolicy = {
  firstAlertSeconds: 60 * 60,
  secondAlertSeconds: 12 * 60 * 60,
  failoverSeconds: 24 * 60 * 60,
};

export type CustodyAction =
  | "none"
  | "alert-first"
  | "alert-second"
  | "transfer"
  | "block-no-host";

export interface CustodyDecision {
  readonly action: CustodyAction;
  readonly offlineSeconds: number;
  readonly destinationHostId?: string;
  readonly nextCustodyEpoch?: number;
}

function supportsLane(host: HostRecord, requiredLane: HostLane): boolean {
  if (requiredLane === "macos") {
    return host.lane === "macos";
  }
  return host.lane === "linux" || host.lane === "macos";
}

export function decideCustody(input: {
  readonly claim: DispatchClaim;
  readonly sourceHost: HostRecord;
  readonly hosts: readonly HostRecord[];
  readonly requiredLane: HostLane;
  readonly now: string;
  readonly policy?: CustodyPolicy;
}): CustodyDecision {
  const policy = input.policy ?? APPROVED_CUSTODY_POLICY;
  if (input.sourceHost.online) {
    return { action: "none", offlineSeconds: 0 };
  }
  const nowMs = Date.parse(input.now);
  const heartbeatMs = Date.parse(input.sourceHost.lastHeartbeatAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(heartbeatMs)) {
    throw new TypeError("Custody timestamps must be valid ISO timestamps.");
  }
  const offlineSeconds = Math.max(0, (nowMs - heartbeatMs) / 1_000);
  if (offlineSeconds < policy.firstAlertSeconds) {
    return { action: "none", offlineSeconds };
  }
  if (offlineSeconds < policy.secondAlertSeconds) {
    return { action: "alert-first", offlineSeconds };
  }
  if (offlineSeconds < policy.failoverSeconds) {
    return { action: "alert-second", offlineSeconds };
  }
  const destination = input.hosts
    .filter((host) => host.id !== input.sourceHost.id)
    .filter((host) => host.online && supportsLane(host, input.requiredLane))
    .sort(
      (left, right) =>
        left.activeClaims.length - right.activeClaims.length ||
        left.id.localeCompare(right.id),
    )[0];
  if (destination === undefined) {
    return { action: "block-no-host", offlineSeconds };
  }
  return {
    action: "transfer",
    offlineSeconds,
    destinationHostId: destination.id,
    nextCustodyEpoch: input.claim.custodyEpoch + 1,
  };
}

export function validateCheckpointForResume(input: {
  readonly checkpoint: CustodyCheckpoint;
  readonly claim: DispatchClaim;
  readonly expectedEpoch: number;
}): { readonly valid: boolean; readonly reason: string } {
  if (input.checkpoint.claimId !== input.claim.claimId) {
    return { valid: false, reason: "checkpoint-claim-mismatch" };
  }
  if (input.expectedEpoch !== input.claim.custodyEpoch + 1) {
    return { valid: false, reason: "custody-epoch-not-advanced" };
  }
  if (input.checkpoint.custodyEpoch !== input.claim.custodyEpoch) {
    return { valid: false, reason: "checkpoint-epoch-mismatch" };
  }
  if (!/^[0-9a-f]{64}$/u.test(input.checkpoint.patchDigest)) {
    return { valid: false, reason: "checkpoint-digest-invalid" };
  }
  return { valid: true, reason: "valid" };
}

export function isCheckpointPathAllowed(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("../")) {
    return false;
  }
  const forbiddenSegments = new Set([
    ".env",
    ".git",
    ".npmrc",
    ".ssh",
    "auth.json",
    "node_modules",
  ]);
  return !normalized
    .split("/")
    .some((segment) => forbiddenSegments.has(segment) || segment.endsWith(".pem"));
}
