import type { ExecutionAccountProfiles } from "../config/account-profiles.js";
import type {
  AccountUsageSnapshot,
  ExecutionAccount,
  HostLane,
  HostRecord,
} from "../domain/types.js";
import { selectExecutionRoute } from "../policy/routing.js";

export interface RoutePlannerRequest {
  readonly requiredLane: HostLane;
  readonly now: string;
}

export interface PlannedExecutionRoute {
  readonly hostId: string;
  readonly accountId: string;
  readonly driverId: string;
  readonly quotaAction: "admit" | "throttle";
}

export interface RoutePlannerResult {
  readonly reason:
    | "selected"
    | "no-host"
    | "no-account"
    | "telemetry-unavailable"
    | "no-headroom";
  readonly route?: PlannedExecutionRoute;
  readonly missingTelemetryAccountIds: readonly string[];
}

export function planExecutionRouteFromState(input: {
  readonly requiredLane: HostLane;
  readonly hosts: readonly HostRecord[];
  readonly profiles: ExecutionAccountProfiles;
  readonly usageByAccountId: Readonly<Record<string, AccountUsageSnapshot | null>>;
  readonly now: string;
}): RoutePlannerResult {
  const missingTelemetryAccountIds: string[] = [];
  const accounts: ExecutionAccount[] = [];
  for (const [id, profile] of Object.entries(input.profiles).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const activeHostIds = profile.hostIds.filter((hostId) => {
      const host = input.hosts.find((candidate) => candidate.id === hostId);
      return (
        host !== undefined &&
        host.online &&
        (input.requiredLane === "linux" || host.lane === "macos") &&
        host.accountIds.includes(id)
      );
    });
    if (!profile.enabled || activeHostIds.length === 0) {
      continue;
    }
    const usage = input.usageByAccountId[id];
    if (usage === undefined || usage === null) {
      missingTelemetryAccountIds.push(id);
      continue;
    }
    accounts.push({
      id,
      driverId: profile.driverId,
      enabled: true,
      hostIds: activeHostIds,
      usage,
    });
  }
  const decision = selectExecutionRoute({
    requiredLane: input.requiredLane,
    hosts: input.hosts,
    accounts,
    now: input.now,
  });
  if (decision.route !== undefined) {
    return {
      reason: "selected",
      route: {
        hostId: decision.route.host.id,
        accountId: decision.route.account.id,
        driverId: decision.route.account.driverId,
        quotaAction: decision.route.quotaAction,
      },
      missingTelemetryAccountIds,
    };
  }
  const reason =
    decision.reason === "no-account" && missingTelemetryAccountIds.length > 0
      ? "telemetry-unavailable"
      : decision.reason;
  return { reason, missingTelemetryAccountIds };
}
