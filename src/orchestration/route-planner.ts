import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { ExecutionAccountProfiles } from "../config/account-profiles.js";
import type {
  AccountUsageSnapshot,
  ExecutionAccount,
  HostLane,
  HostRecord,
} from "../domain/types.js";
import { selectExecutionRoute } from "../policy/routing.js";
import type { HostEnrollments } from "../security/host-enrollment.js";
import { accountGovernor } from "./account-governor.js";
import { hostRegistry } from "./host-registry.js";

const requestSchema = z.object({
  requiredLane: z.enum(["linux", "macos"]),
  now: z.iso.datetime(),
});

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

export function createRoutePlanner(
  enrollments: HostEnrollments,
  profiles: ExecutionAccountProfiles,
) {
  const hostIds = Object.entries(enrollments)
    .filter(([, enrollment]) => enrollment.enabled)
    .map(([hostId]) => hostId)
    .sort();
  const accountIds = Object.keys(profiles).sort();
  return restate.service({
    name: "RoutePlanner",
    options: { ingressPrivate: true },
    handlers: {
      plan: async (
        ctx: restate.Context,
        rawRequest: RoutePlannerRequest,
      ): Promise<RoutePlannerResult> => {
        const request = requestSchema.parse(rawRequest);
        const hosts: HostRecord[] = [];
        for (const hostId of hostIds) {
          const host = await ctx.objectClient(hostRegistry, hostId).read({
            now: request.now,
            staleAfterSeconds: 120,
          });
          if (host !== null) {
            hosts.push(host);
          }
        }
        const usageByAccountId: Record<string, AccountUsageSnapshot | null> = {};
        for (const accountId of accountIds) {
          const status = await ctx.objectClient(accountGovernor, accountId).status();
          usageByAccountId[accountId] = status.snapshot;
        }
        return planExecutionRouteFromState({
          requiredLane: request.requiredLane,
          hosts,
          profiles,
          usageByAccountId,
          now: request.now,
        });
      },
    },
  });
}

export const routePlannerApi = createRoutePlanner({}, {});
