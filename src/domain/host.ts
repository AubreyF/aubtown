import type { HostLane } from "./types.js";

export interface HostHeartbeat {
  readonly hostId: string;
  readonly lane: HostLane;
  readonly observedAt: string;
  readonly activeClaims: readonly string[];
  readonly accountIds: readonly string[];
}
