import * as restate from "@restatedev/restate-sdk";
import type { HostLane, HostRecord } from "../domain/types.js";

interface HostState {
  host: HostRecord;
}

export interface HostHeartbeat {
  readonly hostId: string;
  readonly lane: HostLane;
  readonly observedAt: string;
  readonly activeClaims: readonly string[];
  readonly accountIds: readonly string[];
}

export const hostRegistry = restate.object({
  name: "HostRegistry",
  options: { ingressPrivate: true },
  handlers: {
    heartbeat: async (
      ctx: restate.ObjectContext<HostState>,
      input: HostHeartbeat,
    ): Promise<HostRecord> => {
      if (input.hostId !== ctx.key) {
        throw new restate.TerminalError("Heartbeat host does not match registry key.");
      }
      if (!Number.isFinite(Date.parse(input.observedAt))) {
        throw new restate.TerminalError("Heartbeat timestamp is invalid.");
      }
      const current = await ctx.get("host");
      if (
        current !== null &&
        Date.parse(input.observedAt) < Date.parse(current.lastHeartbeatAt)
      ) {
        throw new restate.TerminalError("Heartbeat is older than durable host state.");
      }
      if (current !== null && current.lane !== input.lane) {
        throw new restate.TerminalError("Host lane cannot change without reenrollment.");
      }
      const host: HostRecord = {
        id: input.hostId,
        lane: input.lane,
        online: true,
        lastHeartbeatAt: input.observedAt,
        activeClaims: [...new Set(input.activeClaims)].sort(),
        accountIds: [...new Set(input.accountIds)].sort(),
      };
      ctx.set("host", host);
      return host;
    },
    read: restate.handlers.object.shared(
      async (
        ctx: restate.ObjectSharedContext<HostState>,
        input: { readonly now: string; readonly staleAfterSeconds?: number },
      ): Promise<HostRecord | null> => {
        const host = await ctx.get("host");
        if (host === null) {
          return null;
        }
        const staleAfterSeconds = input.staleAfterSeconds ?? 120;
        const ageSeconds =
          (Date.parse(input.now) - Date.parse(host.lastHeartbeatAt)) / 1_000;
        return { ...host, online: ageSeconds >= 0 && ageSeconds <= staleAfterSeconds };
      },
    ),
  },
});
