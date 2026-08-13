import * as restate from "@restatedev/restate-sdk";
import type { DispatchClaim, HostRecord } from "../domain/types.js";
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
import { executorCommandRegistry } from "./executor-command-registry.js";
import {
  assertCommandMatchesCurrentClaim,
  type ExecutorStartCommand,
} from "../execution/command.js";
import { decideQuota } from "../policy/quota.js";
import {
  verifyCheckpointStorageReceipt,
  type SignedCheckpointStorageReceipt,
} from "../checkpoints/receipt.js";
import { checkpointCatalog } from "./checkpoint-catalog.js";
import { hostRestoreRegistry } from "./host-restore-registry.js";
import type {
  CustodyRestoreRequirement,
  CustodyRestoreState,
} from "../execution/restore.js";

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
    }
  | {
      readonly kind: "checkpoint-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly reference: string;
      readonly storedAt: string;
    }
  | {
      readonly kind: "restore-poll";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly requirement: CustodyRestoreRequirement | null;
      readonly reason: "required" | "no-restore" | "restored" | "claim-stale";
    }
  | {
      readonly kind: "restore-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly claimId: string;
      readonly custodyEpoch: number;
      readonly checkpointReference: string;
    }
  | {
      readonly kind: "executor-poll";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly command: ExecutorStartCommand | null;
      readonly reason:
        | "offered"
        | "no-command"
        | "quota-unavailable"
        | "quota-blocked"
        | "restore-required"
        | "claim-stale";
    }
  | {
      readonly kind: "executor-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly commandId: string;
      readonly stage: "started" | "completed" | "interrupted" | "failed";
    }
  | {
      readonly kind: "executor-reconcile";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly commandId: string;
      readonly action: "resume" | "quarantine";
      readonly reason:
        | "current"
        | "command-stale"
        | "claim-stale"
        | "restore-required"
        | "quota-unavailable"
        | "quota-blocked";
    };

function terminal(message: string, errorCode = 403): never {
  throw new restate.TerminalError(message, { errorCode });
}

function restoreRequirementMatchesClaim(
  requirement: CustodyRestoreRequirement,
  claim: DispatchClaim,
  hostId: string,
): boolean {
  return (
    requirement.repository.owner === claim.repository.owner &&
    requirement.repository.name === claim.repository.name &&
    requirement.repository.defaultBranch === claim.repository.defaultBranch &&
    requirement.issueNumber === claim.issueNumber &&
    requirement.claimId === claim.claimId &&
    requirement.custodyEpoch === claim.custodyEpoch &&
    requirement.destinationHostId === hostId &&
    requirement.destinationHostId === claim.hostId &&
    requirement.destinationWorkerId === claim.workerId &&
    requirement.destinationWorktree === claim.worktree &&
    requirement.branch === claim.branch &&
    requirement.claimedAt === claim.claimedAt &&
    JSON.stringify([...requirement.conflictDomains].sort()) ===
      JSON.stringify([...claim.conflictDomains].sort())
  );
}

function restoreStateSatisfiesClaim(
  restore: CustodyRestoreState | null,
  claim: DispatchClaim,
  hostId: string,
): boolean {
  return (
    restore?.stage === "restored" &&
    restoreRequirementMatchesClaim(restore.requirement, claim, hostId)
  );
}

export function createHostGateway(
  enrollments: HostEnrollments,
  checkpointGrantIssuer: CheckpointGrantIssuer | undefined = undefined,
  checkpointReceiptPublicKeyPem: string | undefined = undefined,
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
          } else if (envelope.kind === "checkpoint-grant") {
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
          } else if (envelope.kind === "checkpoint-receipt") {
            if (checkpointReceiptPublicKeyPem === undefined) {
              return terminal("Checkpoint storage receipts are not configured", 503);
            }
            let stored: SignedCheckpointStorageReceipt;
            try {
              stored = verifyCheckpointStorageReceipt({
                receipt: envelope.payload,
                publicKeyPem: checkpointReceiptPublicKeyPem,
              });
            } catch (error) {
              return terminal(
                error instanceof Error
                  ? error.message
                  : "Checkpoint storage receipt is invalid",
                409,
              );
            }
            const manifest = stored.manifest;
            const claimKey = `${manifest.repository.owner}/${manifest.repository.name}#${manifest.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
            const currentClaim = await ctx.objectClient(claimRegistry, claimKey).read();
            if (
              currentClaim === null ||
              stored.hostId !== envelope.hostId ||
              manifest.sourceHostId !== envelope.hostId ||
              currentClaim.repository.owner !== manifest.repository.owner ||
              currentClaim.repository.name !== manifest.repository.name ||
              currentClaim.repository.defaultBranch !==
                manifest.repository.defaultBranch ||
              currentClaim.issueNumber !== manifest.issueNumber ||
              currentClaim.claimId !== manifest.claimId ||
              currentClaim.custodyEpoch !== manifest.custodyEpoch ||
              currentClaim.hostId !== envelope.hostId
            ) {
              return terminal(
                "Checkpoint storage receipt does not match current claim custody",
                409,
              );
            }
            await ctx.objectClient(checkpointCatalog, stored.reference).record(stored);
            receipt = {
              kind: "checkpoint-receipt",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              reference: stored.reference,
              storedAt: stored.storedAt,
            };
          } else if (envelope.kind === "restore-poll") {
            const restore = await ctx
              .objectClient(hostRestoreRegistry, envelope.hostId)
              .read();
            if (restore === null) {
              receipt = {
                kind: "restore-poll",
                hostId: envelope.hostId,
                sequence: envelope.sequence,
                acceptedAt,
                requirement: null,
                reason: "no-restore",
              };
            } else if (restore.stage === "restored") {
              receipt = {
                kind: "restore-poll",
                hostId: envelope.hostId,
                sequence: envelope.sequence,
                acceptedAt,
                requirement: null,
                reason: "restored",
              };
            } else {
              const required = restore.requirement;
              const claimKey = `${required.repository.owner}/${required.repository.name}#${required.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
              const currentClaim = await ctx
                .objectClient(claimRegistry, claimKey)
                .read();
              const current =
                currentClaim !== null &&
                restoreRequirementMatchesClaim(
                  required,
                  currentClaim,
                  envelope.hostId,
                );
              receipt = {
                kind: "restore-poll",
                hostId: envelope.hostId,
                sequence: envelope.sequence,
                acceptedAt,
                requirement: current ? required : null,
                reason: current ? "required" : "claim-stale",
              };
            }
          } else if (envelope.kind === "restore-receipt") {
            const reported = envelope.payload;
            if (reported.destinationHostId !== envelope.hostId) {
              return terminal("Custody restore receipt targets another host", 409);
            }
            const restore = await ctx
              .objectClient(hostRestoreRegistry, envelope.hostId)
              .read();
            if (restore === null) {
              return terminal("Host has no custody restore requirement", 409);
            }
            const required = restore.requirement;
            const claimKey = `${required.repository.owner}/${required.repository.name}#${required.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
            const currentClaim = await ctx
              .objectClient(claimRegistry, claimKey)
              .read();
            if (
              currentClaim === null ||
              !restoreRequirementMatchesClaim(
                required,
                currentClaim,
                envelope.hostId,
              )
            ) {
              return terminal(
                "Custody restore receipt does not match current claim custody",
                409,
              );
            }
            const recorded = await ctx
              .objectClient(hostRestoreRegistry, envelope.hostId)
              .record({ ...reported, restoredAt: acceptedAt });
            receipt = {
              kind: "restore-receipt",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              claimId: recorded.requirement.claimId,
              custodyEpoch: recorded.requirement.custodyEpoch,
              checkpointReference: recorded.requirement.checkpointReference,
            };
          } else if (envelope.kind === "executor-poll") {
            const accountId = envelope.payload.accountId;
            if (!enrollment.accountIds.includes(accountId)) {
              return terminal("Executor poll account is outside host enrollment");
            }
            const account = await ctx.objectClient(accountGovernor, accountId).status();
            if (account.snapshot === null) {
              receipt = {
                kind: "executor-poll",
                hostId: envelope.hostId,
                sequence: envelope.sequence,
                acceptedAt,
                command: null,
                reason: "quota-unavailable",
              };
            } else {
              const decision = decideQuota({ snapshot: account.snapshot, now: acceptedAt });
              if (decision.action !== "admit" && decision.action !== "throttle") {
                receipt = {
                  kind: "executor-poll",
                  hostId: envelope.hostId,
                  sequence: envelope.sequence,
                  acceptedAt,
                  command: null,
                  reason: "quota-blocked",
                };
              } else {
                const registry = ctx.objectClient(executorCommandRegistry, envelope.hostId);
                const state = await registry.read();
                if (
                  state === null ||
                  (state.stage !== "pending" && state.stage !== "offered")
                ) {
                  receipt = {
                    kind: "executor-poll",
                    hostId: envelope.hostId,
                    sequence: envelope.sequence,
                    acceptedAt,
                    command: null,
                    reason: "no-command",
                  };
                } else {
                  const command = state.command;
                  const claimKey = `${command.claim.repository.owner}/${command.claim.repository.name}#${command.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
                  const currentClaim = await ctx.objectClient(claimRegistry, claimKey).read();
                  let restoreSatisfied = false;
                  if (currentClaim?.custodyEpoch === 1) {
                    restoreSatisfied = true;
                  } else if (currentClaim !== null) {
                    const restore = await ctx
                      .objectClient(hostRestoreRegistry, envelope.hostId)
                      .read();
                    restoreSatisfied = restoreStateSatisfiesClaim(
                      restore,
                      currentClaim,
                      envelope.hostId,
                    );
                  }
                  if (currentClaim === null) {
                    await registry.cancel({
                      commandId: command.commandId,
                      cancelledAt: acceptedAt,
                      reason: "Executor command has no current claim.",
                    });
                    receipt = {
                      kind: "executor-poll",
                      hostId: envelope.hostId,
                      sequence: envelope.sequence,
                      acceptedAt,
                      command: null,
                      reason: "claim-stale",
                    };
                  } else if (!restoreSatisfied) {
                    receipt = {
                      kind: "executor-poll",
                      hostId: envelope.hostId,
                      sequence: envelope.sequence,
                      acceptedAt,
                      command: null,
                      reason: "restore-required",
                    };
                  } else {
                    try {
                      assertCommandMatchesCurrentClaim({
                        command,
                        currentClaim,
                        requestingHostId: envelope.hostId,
                        accountId,
                        hostLane: enrollment.lane,
                        now: acceptedAt,
                      });
                      await registry.offer({
                        commandId: command.commandId,
                        offeredAt: acceptedAt,
                      });
                      receipt = {
                        kind: "executor-poll",
                        hostId: envelope.hostId,
                        sequence: envelope.sequence,
                        acceptedAt,
                        command,
                        reason: "offered",
                      };
                    } catch (error) {
                      await registry.cancel({
                        commandId: command.commandId,
                        cancelledAt: acceptedAt,
                        reason:
                          error instanceof Error
                            ? error.message
                            : "Executor command is stale.",
                      });
                      receipt = {
                        kind: "executor-poll",
                        hostId: envelope.hostId,
                        sequence: envelope.sequence,
                        acceptedAt,
                        command: null,
                        reason: "claim-stale",
                      };
                    }
                  }
                }
              }
            }
          } else if (envelope.kind === "executor-reconcile") {
            const requested = envelope.payload;
            const quarantine = (
              reason:
                | "command-stale"
                | "claim-stale"
                | "restore-required"
                | "quota-unavailable"
                | "quota-blocked",
            ): HostGatewayReceipt => ({
              kind: "executor-reconcile",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              commandId: requested.commandId,
              action: "quarantine",
              reason,
            });
            if (!enrollment.accountIds.includes(requested.accountId)) {
              return terminal("Executor reconciliation account is outside host enrollment");
            }
            const registry = ctx.objectClient(executorCommandRegistry, envelope.hostId);
            const state = await registry.read();
            if (
              state === null ||
              state.command.commandId !== requested.commandId ||
              state.stage !== "started" ||
              state.threadId !== requested.threadId ||
              state.turnId !== requested.turnId
            ) {
              receipt = quarantine("command-stale");
            } else {
              const command = state.command;
              const claimKey = `${command.claim.repository.owner}/${command.claim.repository.name}#${command.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
              const currentClaim = await ctx.objectClient(claimRegistry, claimKey).read();
              let claimCurrent = true;
              try {
                if (
                  currentClaim === null ||
                  requested.claimId !== command.claim.claimId ||
                  requested.custodyEpoch !== command.claim.custodyEpoch
                ) {
                  throw new Error("Executor reconciliation claim is stale.");
                }
                assertCommandMatchesCurrentClaim({
                  command,
                  currentClaim,
                  requestingHostId: envelope.hostId,
                  accountId: requested.accountId,
                  hostLane: enrollment.lane,
                  now: acceptedAt,
                  enforceStartWindow: false,
                });
              } catch {
                claimCurrent = false;
              }
              if (!claimCurrent) {
                receipt = quarantine("claim-stale");
              } else {
                const restore =
                  currentClaim !== null && currentClaim.custodyEpoch > 1
                    ? await ctx
                        .objectClient(hostRestoreRegistry, envelope.hostId)
                        .read()
                    : null;
                const restoreSatisfied =
                  currentClaim?.custodyEpoch === 1 ||
                  (currentClaim !== null &&
                    restoreStateSatisfiesClaim(
                      restore,
                      currentClaim,
                      envelope.hostId,
                    ));
                if (!restoreSatisfied) {
                  receipt = quarantine("restore-required");
                } else {
                  const account = await ctx
                    .objectClient(accountGovernor, requested.accountId)
                    .status();
                  if (account.snapshot === null) {
                    receipt = quarantine("quota-unavailable");
                  } else {
                    const decision = decideQuota({
                      snapshot: account.snapshot,
                      now: acceptedAt,
                    });
                    receipt =
                      decision.action === "admit" ||
                      decision.action === "throttle"
                        ? {
                            kind: "executor-reconcile",
                            hostId: envelope.hostId,
                            sequence: envelope.sequence,
                            acceptedAt,
                            commandId: requested.commandId,
                            action: "resume",
                            reason: "current",
                          }
                        : quarantine("quota-blocked");
                  }
                }
              }
            }
          } else {
            const reported = envelope.payload;
            if (!enrollment.accountIds.includes(reported.accountId)) {
              return terminal("Executor receipt account is outside host enrollment");
            }
            const registry = ctx.objectClient(executorCommandRegistry, envelope.hostId);
            const state = await registry.read();
            if (state === null || state.command.commandId !== reported.commandId) {
              return terminal("Executor receipt has no current command", 409);
            }
            const command = state.command;
            const claimKey = `${command.claim.repository.owner}/${command.claim.repository.name}#${command.claim.issueNumber.toLocaleString("en-US", { useGrouping: false })}`;
            const currentClaim = await ctx.objectClient(claimRegistry, claimKey).read();
            if (currentClaim === null) {
              return terminal("Executor receipt has no current claim", 409);
            }
            try {
              assertCommandMatchesCurrentClaim({
                command,
                currentClaim,
                requestingHostId: envelope.hostId,
                accountId: reported.accountId,
                hostLane: enrollment.lane,
                now: acceptedAt,
                enforceStartWindow: false,
              });
            } catch (error) {
              return terminal(
                error instanceof Error ? error.message : "Executor receipt claim is stale",
                409,
              );
            }
            const recorded = await registry.record({
              receipt: { ...reported, observedAt: acceptedAt },
              acceptedAt,
            });
            receipt = {
              kind: "executor-receipt",
              hostId: envelope.hostId,
              sequence: envelope.sequence,
              acceptedAt,
              commandId: command.commandId,
              stage: recorded.stage as
                | "started"
                | "completed"
                | "interrupted"
                | "failed",
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
