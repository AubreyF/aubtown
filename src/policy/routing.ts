import type {
  ExecutionAccount,
  HostLane,
  HostRecord,
  HostRoute,
} from "../domain/types.js";
import { selectExecutionAccount, type QuotaPolicy } from "./quota.js";

function supportsLane(host: HostRecord, requiredLane: HostLane): boolean {
  return requiredLane === "linux" || host.lane === "macos";
}

export interface RouteDecision {
  readonly route?: HostRoute;
  readonly reason: "selected" | "no-host" | "no-account" | "no-headroom";
}

export function selectExecutionRoute(input: {
  readonly requiredLane: HostLane;
  readonly hosts: readonly HostRecord[];
  readonly accounts: readonly ExecutionAccount[];
  readonly now: string;
  readonly policy?: QuotaPolicy;
}): RouteDecision {
  const eligibleHosts = input.hosts
    .filter((host) => host.online && supportsLane(host, input.requiredLane))
    .sort(
      (left, right) =>
        left.activeClaims.length - right.activeClaims.length ||
        left.id.localeCompare(right.id),
    );
  if (eligibleHosts.length === 0) {
    return { reason: "no-host" };
  }

  const accountSelection = selectExecutionAccount({
    accounts: input.accounts,
    eligibleHostIds: eligibleHosts.map((host) => host.id),
    now: input.now,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
  if (accountSelection.account === undefined) {
    return {
      reason:
        accountSelection.reason === "no-enabled-account"
          ? "no-account"
          : "no-headroom",
    };
  }
  const account = accountSelection.account;
  const host = eligibleHosts.find((candidate) =>
    account.hostIds.includes(candidate.id),
  );
  if (host === undefined) {
    return { reason: "no-account" };
  }
  const quota = accountSelection.decisions[account.id];
  if (quota === undefined || (quota.action !== "admit" && quota.action !== "throttle")) {
    return { reason: "no-headroom" };
  }
  return {
    reason: "selected",
    route: { host, account, quotaAction: quota.action },
  };
}
