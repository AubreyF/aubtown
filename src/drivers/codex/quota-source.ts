import type { RawAccountUsageObservation } from "../../domain/types.js";
import type { UsageSource } from "../worker.js";
import { ROLLING_WEEKLY_WINDOW_MINUTES } from "../../policy/quota.js";
import {
  CodexAppServerClient,
  type CodexRateLimits,
} from "./app-server-client.js";

export function selectRollingWeeklyWindow(limits: CodexRateLimits): {
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt: number;
} {
  const buckets = [
    limits.rateLimits,
    ...Object.values(limits.rateLimitsByLimitId ?? {}),
  ];
  const windows = buckets.flatMap((bucket) =>
    bucket.secondary === undefined || bucket.secondary === null
      ? [bucket.primary]
      : [bucket.primary, bucket.secondary],
  );
  const weekly = windows
    .filter((window) => window.windowDurationMins === ROLLING_WEEKLY_WINDOW_MINUTES)
    .sort(
      (left, right) =>
        right.usedPercent - left.usedPercent || left.resetsAt - right.resetsAt,
    );
  const governing = weekly[0];
  if (governing === undefined) {
    throw new Error(
      "Codex telemetry does not expose a 10,080 minute rolling window. Weekly admission must fail closed.",
    );
  }
  return governing;
}

export class CodexQuotaSource implements UsageSource {
  readonly id = "codex-app-server-rate-limits-v1";
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(
    accountId: string,
    activeTurnIds: readonly string[],
  ): Promise<RawAccountUsageObservation> {
    const [limits, usage] = await Promise.all([
      this.client.readRateLimits(),
      this.client.readUsage(),
    ]);
    const weekly = selectRollingWeeklyWindow(limits);
    const lifetimeTokens = usage.summary?.lifetimeTokens;
    if (
      lifetimeTokens === null ||
      lifetimeTokens === undefined ||
      !Number.isSafeInteger(lifetimeTokens) ||
      lifetimeTokens < 0
    ) {
      throw new Error(
        "Codex token activity does not expose a cumulative lifetimeTokens counter. Daily governance must fail closed.",
      );
    }
    const resetsAt = new Date(weekly.resetsAt * 1_000).toISOString();
    const observedAt = this.now().toISOString();
    return {
      accountId,
      observedAt,
      primary: {
        usedPercent: weekly.usedPercent,
        windowDurationMinutes: weekly.windowDurationMins,
        resetsAt,
      },
      lifetimeTokens,
      activeTurnIds,
    };
  }
}
