import type {
  AccountUsageSnapshot,
  ExecutionAccount,
  RawAccountUsageObservation,
} from "../domain/types.js";

export interface QuotaPolicy {
  readonly autonomousWeeklyCeilingPercent: number;
  readonly dailyThrottlePercent: number;
  readonly dailyAdmissionStopPercent: number;
  readonly dailyInterruptPercent: number;
  readonly telemetryMaxAgeSeconds: number;
}

export const APPROVED_QUOTA_POLICY: QuotaPolicy = {
  autonomousWeeklyCeilingPercent: 80,
  dailyThrottlePercent: 7,
  dailyAdmissionStopPercent: 9,
  dailyInterruptPercent: 10,
  telemetryMaxAgeSeconds: 120,
};

const LOS_ANGELES_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function losAngelesDayKey(isoTimestamp: string): string {
  const instant = new Date(isoTimestamp);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError("Usage timestamp must be a valid ISO timestamp.");
  }
  return LOS_ANGELES_DAY.format(instant);
}

export function mergeUsageObservation(input: {
  readonly previous?: AccountUsageSnapshot;
  readonly observation: RawAccountUsageObservation;
}): AccountUsageSnapshot {
  const previous = input.previous;
  const sameDay =
    previous !== undefined &&
    losAngelesDayKey(previous.observedAt) ===
      losAngelesDayKey(input.observation.observedAt);
  const sameWindow =
    previous !== undefined &&
    previous.primary.resetsAt === input.observation.primary.resetsAt;
  const dailyBaseline =
    sameDay && sameWindow
      ? previous.dailyBaseline
      : {
          observedAt: input.observation.observedAt,
          usedPercent: input.observation.primary.usedPercent,
          resetsAt: input.observation.primary.resetsAt,
        };
  return { ...input.observation, dailyBaseline };
}

export type QuotaAction =
  | "admit"
  | "throttle"
  | "stop-admission"
  | "interrupt";

export interface QuotaDecision {
  readonly action: QuotaAction;
  readonly reason:
    | "headroom-available"
    | "telemetry-stale"
    | "weekly-ceiling"
    | "daily-throttle"
    | "daily-admission-stop"
    | "daily-interrupt";
  readonly weeklyUsedPercent: number;
  readonly dailyUsedPercent: number;
  readonly observedAt: string;
}

function assertPercent(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be between 0 and 100.`);
  }
}

export function dailyUsagePercent(snapshot: AccountUsageSnapshot): number {
  assertPercent(snapshot.primary.usedPercent, "primary.usedPercent");
  assertPercent(snapshot.dailyBaseline.usedPercent, "dailyBaseline.usedPercent");
  if (snapshot.primary.resetsAt !== snapshot.dailyBaseline.resetsAt) {
    return snapshot.primary.usedPercent;
  }
  return Math.max(0, snapshot.primary.usedPercent - snapshot.dailyBaseline.usedPercent);
}

export function decideQuota(input: {
  readonly snapshot: AccountUsageSnapshot;
  readonly now: string;
  readonly policy?: QuotaPolicy;
}): QuotaDecision {
  const policy = input.policy ?? APPROVED_QUOTA_POLICY;
  const observedAtMs = Date.parse(input.snapshot.observedAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Quota timestamps must be valid ISO timestamps.");
  }
  const weeklyUsedPercent = input.snapshot.primary.usedPercent;
  const dailyUsed = dailyUsagePercent(input.snapshot);
  const ageSeconds = Math.max(0, (nowMs - observedAtMs) / 1_000);

  const decision = (
    action: QuotaAction,
    reason: QuotaDecision["reason"],
  ): QuotaDecision => ({
    action,
    reason,
    weeklyUsedPercent,
    dailyUsedPercent: dailyUsed,
    observedAt: input.snapshot.observedAt,
  });

  if (ageSeconds > policy.telemetryMaxAgeSeconds) {
    return decision("interrupt", "telemetry-stale");
  }
  if (weeklyUsedPercent >= policy.autonomousWeeklyCeilingPercent) {
    return decision("interrupt", "weekly-ceiling");
  }
  if (dailyUsed >= policy.dailyInterruptPercent) {
    return decision("interrupt", "daily-interrupt");
  }
  if (dailyUsed >= policy.dailyAdmissionStopPercent) {
    return decision("stop-admission", "daily-admission-stop");
  }
  if (dailyUsed >= policy.dailyThrottlePercent) {
    return decision("throttle", "daily-throttle");
  }
  return decision("admit", "headroom-available");
}

export interface AccountSelection {
  readonly account?: ExecutionAccount;
  readonly decisions: Readonly<Record<string, QuotaDecision>>;
  readonly reason: "selected" | "no-enabled-account" | "no-headroom";
}

export function selectExecutionAccount(input: {
  readonly accounts: readonly ExecutionAccount[];
  readonly eligibleHostIds: readonly string[];
  readonly now: string;
  readonly policy?: QuotaPolicy;
}): AccountSelection {
  const decisions: Record<string, QuotaDecision> = {};
  const candidates = input.accounts
    .filter((account) => account.enabled)
    .filter((account) =>
      account.hostIds.some((hostId) => input.eligibleHostIds.includes(hostId)),
    )
    .map((account) => {
      const decision = decideQuota({
        snapshot: account.usage,
        now: input.now,
        ...(input.policy === undefined ? {} : { policy: input.policy }),
      });
      decisions[account.id] = decision;
      return { account, decision };
    });

  if (candidates.length === 0) {
    return { decisions, reason: "no-enabled-account" };
  }
  const usable = candidates
    .filter(({ decision }) =>
      decision.action === "admit" || decision.action === "throttle",
    )
    .sort(
      (left, right) =>
        left.decision.weeklyUsedPercent - right.decision.weeklyUsedPercent ||
        left.account.id.localeCompare(right.account.id),
    );
  const selected = usable[0];
  if (selected === undefined) {
    return { decisions, reason: "no-headroom" };
  }
  return { account: selected.account, decisions, reason: "selected" };
}
