import type { AdjudicationCommand } from "../adjudication/command.js";
import type { SignedCheckpointGrant } from "../checkpoints/grant.js";
import type { HostRecord } from "../domain/types.js";
import type { ExecutorStartCommand } from "../execution/command.js";
import type { CustodyRestoreRequirement } from "../execution/restore.js";
import type { InitialWorkspaceRequirement } from "../execution/workspace.js";
import type { QuotaDecision } from "../policy/quota.js";

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
      readonly kind: "workspace-poll";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly requirement: InitialWorkspaceRequirement | null;
      readonly reason: "required" | "no-workspace" | "prepared" | "claim-stale";
    }
  | {
      readonly kind: "workspace-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly claimId: string;
      readonly custodyEpoch: 1;
      readonly baseHead: string;
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
        | "workspace-required"
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
      readonly checkpointReference?: string;
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
        | "workspace-required"
        | "restore-required"
        | "quota-unavailable"
        | "quota-blocked";
    }
  | {
      readonly kind: "validation-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly checkpointReference: string;
      readonly stage: "awaiting-review" | "ready" | "blocked";
    }
  | {
      readonly kind: "review-receipt";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly checkpointReference: string;
      readonly stage: "ready" | "blocked";
    }
  | {
      readonly kind: "adjudication-poll";
      readonly hostId: string;
      readonly sequence: number;
      readonly acceptedAt: string;
      readonly command: AdjudicationCommand | null;
      readonly action: "validate" | "review" | null;
      readonly reason:
        | "offered"
        | "no-command"
        | "command-terminal"
        | "claim-stale"
        | "quota-unavailable"
        | "quota-blocked";
    };
