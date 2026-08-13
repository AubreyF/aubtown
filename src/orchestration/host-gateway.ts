import * as restate from "@restatedev/restate-sdk";
import type { HostRecord } from "../domain/types.js";
import type { QuotaDecision } from "../policy/quota.js";
import type { HostEnrollments } from "../security/host-enrollment.js";
import {
  parseSignedHostEnvelope,
  verifyHostEnvelope,
  type SignedHostEnvelope,
} from "../security/host-envelope.js";
import { accountGovernor } from "./account-governor.js";
import { hostRegistry } from "./host-registry.js";
import {
  assertCheckpointRequestAuthority,
  CheckpointGrantIssuer,
  type SignedCheckpointGrant,
} from "../checkpoints/grant.js";
import { claimRegistry } from "./claim-registry.js";

const MAX_ENVELOPE_AGE_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 120;

interface HostGatewayState {
  lastSequence: number;
  lastAcceptedAt: string;
}

export type HostGatewayReceipt =
  | {
      readonly kind: "heartbeat";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly host: HostRecord;
    }
  | {
      readonly kind: "quota-observation";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly decision: QuotaDecision;
    }
  | {
      readonly kind: "checkpoint-grant";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly grant: SignedCheckpointGrant;
    };

function terminal(message: string, errorCode = 403): never {
  throw new restate.TerminalError(message, { errorCode });
}

export function createHostGateway(
  enrollments: HostEnrollments,
  checkpointGrantIssuer: CheckpointGrantIssuer | undefined = undefined,
) {
  return restate.object({
    name: "HostGateway",
    handlers: {
      submit: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 8 } },
        async (
          ctx: restate.ObjectContext<HostGatewayState>,
          rawEnvelope: SignedHostEnvelope,
        ): Promise<HostGatewayReceipt> => {
          let envelope: SignedHostEnvelope;
          try {
            envelope = parseSignedHostEnvelope(rawEnvelope);
          } catch {
            return terminal("Host envelope is malformed", 400);
          }
          if (envelope.hostId !== ctx.key) {
            return terminal("Host envelope identity does not match gateway key");
          }
          const enrollment = enrollments[envelope.hostId];
          if (enrollment === undefined || !enrollment.enabled) {
            return terminal("Host is not enrolled");
          }
          let validSignature = false;
          try {
            validSignature = verifyHostEnvelope(envelope, enrollment.publicKeyPem);
          } catch {
            return terminal("Host enrollment key is invalid", 500);
          }
          if (!validSignature) {
            return terminal("Host envelope signature is invalid");
          }
          const lastSequence = (await ctx.get("lastSequence")) ?? 0;
          if (envelope.sequence <= lastSequence) {
            return terminal("Host envelope sequence has already been used", 409);
          }
          const acceptedAt = await ctx.run("coordinator-accepted-at", () =>
            Promise.resolve(new Date().toISOString()),
          );
          const ageSeconds =
            (Date.parse(acceptedAt) - Date.parse(envelope.issuedAt)) / 1_000;
          if (ageSeconds > MAX_ENVELOPE_AGE_SECONDS) {
            return terminal("Host envelope is stale", 408);
          }
          if (ageSeconds < -MAX_FUTURE_SKEW_SECONDS) {
            return terminal("Host envelope timestamp is too far in the future", 400);
          }

          let receipt: HostGatewayReceipt;
          if (envelope.kind === "heartbeat") {
            if (envelope.payload.hostId !== envelope.hostId) {
              return terminal("Heartbeat host identity does not match its envelope");
            }
            if (envelope.payload.lane !== enrollment.lane) {
              return terminal("Heartbeat lane does not match host enrollment");
            }
            if (
              envelope.payload.accountIds.some(
                (accountId) => !enrollment.accountIds.includes(accountId),
              )
            ) {
              return terminal("Heartbeat contains an account outside host enrollment");
            }
            const host = await ctx
              .objectClient(hostRegistry, envelope.hostId)
              .heartbeat(envelope.payload);
            receipt = {
              kind: "heartbeat",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              host,
            };
          } else if (envelope.kind === "quota-observation") {
            const hostObservation = envelope.payload.observation;
            if (!enrollment.accountIds.includes(hostObservation.accountId)) {
              return terminal("Quota observation account is outside host enrollment");
            }
            const observation = { ...hostObservation, observedAt: acceptedAt };
            const decision = await ctx
              .objectClient(accountGovernor, observation.accountId)
              .observe({ observation, now: acceptedAt });
            receipt = {
              kind: "quota-observation",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              decision,
            };
          } else {
            if (checkpointGrantIssuer === undefined) {
              return terminal("Checkpoint transfer grants are not configured", 503);
            }
            const request = envelope.payload;
            const claimKey = `${request.repository.owner}/${request.repository.name}#${request.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
            const currentClaim = await ctx.objectClient(claimRegistry, claimKey).read();
            if (currentClaim === null) {
              return terminal("Checkpoint transfer request has no active claim", 409);
            }
            try {
              assertCheckpointRequestAuthority({
                currentClaim,
                requestingHostId: envelope.hostId,
                request,
              });
            } catch (error) {
              return terminal(
                error instanceof Error ? error.message : "Checkpoint transfer request is invalid",
                409,
              );
            }
            const grant: SignedCheckpointGrant = await ctx.run(
              "issue-checkpoint-transfer-grant",
              () =>
                Promise.resolve(
                  checkpointGrantIssuer.issue({
                    currentClaim,
                    requestingHostId: envelope.hostId,
                    request,
                    issuedAt: acceptedAt,
                  }),
                ),
            );
            receipt = {
              kind: "checkpoint-grant",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              grant,
            };
          }
          ctx.set("lastSequence", envelope.sequence);
          ctx.set("lastAcceptedAt", acceptedAt);
          return receipt;
        },
      ),
    },
  });
}
