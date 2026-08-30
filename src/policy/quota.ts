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

export const ROLLING_WEEKLY_WINDOW_MINUTES = 10_080;

export const APPROVED_QUOTA_POLICY: QuotaPolicy = {
  autonomousWeeklyCeilingPercent: 80,
  dailyThrottlePercent: 15,
  dailyAdmissionStopPercent: 20,
  dailyInterruptPercent: 25,
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
  if (
    previous !== undefined &&
    previous.accountId !== input.observation.accountId
  ) {
    throw new Error("A usage observation cannot change account identity.");
  }
  if (
    !Number.isSafeInteger(input.observation.lifetimeTokens) ||
    input.observation.lifetimeTokens < 0
  ) {
    throw new RangeError("lifetimeTokens must be one nonnegative safe integer.");
  }
  const observationDay = losAngelesDayKey(input.observation.observedAt);
  const sameDay =
    previous !== undefined &&
    previous.dailyConsumption.day === observationDay;
  const dailyBaseline =
    sameDay
      ? {
          ...previous.dailyBaseline,
          // A rolling-window reset estimate can move between app-server
          // sessions without representing new usage. Keep the day's baseline
          // while binding it to the current meter metadata.
          resetsAt: input.observation.primary.resetsAt,
        }
      : {
          observedAt: input.observation.observedAt,
          usedPercent: input.observation.primary.usedPercent,
          resetsAt: input.observation.primary.resetsAt,
        };
  if (
    previous !== undefined &&
    input.observation.lifetimeTokens <
      previous.dailyConsumption.observedLifetimeTokens
  ) {
    throw new Error("Cumulative token activity moved backward.");
  }
  const positiveWindowDelta =
    previous === undefined
      ? 0
      : Math.max(
          0,
          input.observation.primary.usedPercent - previous.primary.usedPercent,
        );
  const priorGross = sameDay
    ? (previous?.dailyConsumption.grossUsedPercent ?? 0)
    : 0;
  const priorDiverged =
    sameDay && previous?.dailyConsumption.meterState === "diverged";
  const dailyConsumption = {
    day: observationDay,
    baselineLifetimeTokens:
      sameDay && previous !== undefined
        ? previous.dailyConsumption.baselineLifetimeTokens
        : (previous?.dailyConsumption.observedLifetimeTokens ??
          input.observation.lifetimeTokens),
    observedLifetimeTokens: input.observation.lifetimeTokens,
    grossUsedPercent: priorGross + positiveWindowDelta,
    // A rolling seven-day percentage may retreat while cumulative activity
    // rises because older use left the window. That is not meter divergence.
    // Backward cumulative activity remains a hard error above.
    meterState: priorDiverged ? ("diverged" as const) : ("coherent" as const),
  };
  return { ...input.observation, dailyBaseline, dailyConsumption };
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
    | "daily-meter-diverged"
    | "daily-throttle"
    | "daily-admission-stop"
    | "daily-interrupt";
  readonly weeklyUsedPercent: number;
  readonly dailyUsedPercent: number;
  readonly observedAt: string;
}

export function dailyUsagePercent(snapshot: AccountUsageSnapshot): number {
  const value = snapshot.dailyConsumption.grossUsedPercent;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("dailyConsumption.grossUsedPercent must be nonnegative.");
  }
  return value;
}

export function decideQuota(input: {
  readonly snapshot: AccountUsageSnapshot;
  readonly now: string;
  readonly policy?: QuotaPolicy;
}): QuotaDecision {
  const policy = input.policy ?? APPROVED_QUOTA_POLICY;
  if (input.snapshot.primary.windowDurationMinutes !== ROLLING_WEEKLY_WINDOW_MINUTES) {
    throw new RangeError("Quota telemetry must describe the 10,080 minute rolling window.");
  }
  const observedAtMs = Date.parse(input.snapshot.observedAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Quota timestamps must be valid ISO timestamps.");
  }
  const weeklyUsedPercent = input.snapshot.primary.usedPercent;
  const dailyUsed = dailyUsagePercent(input.snapshot);
  const ageSeconds = (nowMs - observedAtMs) / 1_000;

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

  if (ageSeconds < 0 || ageSeconds > policy.telemetryMaxAgeSeconds) {
    return decision("interrupt", "telemetry-stale");
  }
  if (weeklyUsedPercent >= policy.autonomousWeeklyCeilingPercent) {
    return decision("interrupt", "weekly-ceiling");
  }
  if (
    input.snapshot.dailyConsumption.meterState === "diverged" ||
    input.snapshot.dailyConsumption.day !==
      losAngelesDayKey(input.snapshot.observedAt) ||
    input.snapshot.dailyConsumption.observedLifetimeTokens <
      input.snapshot.dailyConsumption.baselineLifetimeTokens
  ) {
    return decision("interrupt", "daily-meter-diverged");
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
