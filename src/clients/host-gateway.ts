import type {
  HostHeartbeat,
} from "../orchestration/host-registry.js";
import type { HostGatewayReceipt } from "../orchestration/host-gateway.js";
import type { RawAccountUsageObservation } from "../domain/types.js";
import type { QuotaDecision } from "../policy/quota.js";
import {
  hostEnvelopeDigest,
  signHostEnvelope,
  type UnsignedHostEnvelope,
} from "../security/host-envelope.js";
import type { SequenceSource } from "../security/sequence-store.js";
import type { DurableUsageGovernor } from "../supervision/quota-monitor.js";
import { z } from "zod";
import {
  checkpointGrantRequestSchema,
  type CheckpointGrantRequest,
  type SignedCheckpointGrant,
} from "../checkpoints/grant.js";
import {
  executorCommandReceiptSchema,
  executorReconcileRequestSchema,
  executorStartCommandSchema,
  type ExecutorCommandReportInput,
  type ExecutorReconcileRequest,
} from "../execution/command.js";
import {
  signedCheckpointStorageReceiptSchema,
  type SignedCheckpointStorageReceipt,
} from "../checkpoints/receipt.js";
import {
  custodyRestoreReceiptSchema,
  custodyRestoreRequirementSchema,
  type CustodyRestoreReceipt,
} from "../execution/restore.js";
import {
  initialWorkspaceReceiptSchema,
  initialWorkspaceRequirementSchema,
  type InitialWorkspaceReceipt,
} from "../execution/workspace.js";
import {
  exactValidationReceiptSchema,
  independentReviewReceiptSchema,
  type ExactValidationReceipt,
  type IndependentReviewReceipt,
} from "../adjudication/receipts.js";

const quotaDecisionSchema = z.object({
  action: z.enum(["admit", "throttle", "stop-admission", "interrupt"]),
  reason: z.enum([
    "headroom-available",
    "telemetry-stale",
    "weekly-ceiling",
    "daily-throttle",
    "daily-admission-stop",
    "daily-interrupt",
  ]),
  weeklyUsedPercent: z.number().min(0).max(100),
  dailyUsedPercent: z.number().min(0).max(100),
  observedAt: z.iso.datetime(),
});

const gatewayReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heartbeat"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    host: z.object({
      id: z.string().min(1),
      lane: z.enum(["linux", "macos"]),
      online: z.boolean(),
      lastHeartbeatAt: z.iso.datetime(),
      activeClaims: z.array(z.string()),
      accountIds: z.array(z.string()),
    }),
  }),
  z.object({
    kind: z.literal("quota-observation"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    decision: quotaDecisionSchema,
  }),
  z.object({
    kind: z.literal("checkpoint-grant"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    grant: z.intersection(
      checkpointGrantRequestSchema.extend({
        schemaVersion: z.literal(1),
        hostId: z.string().min(1),
        issuedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        nonce: z.uuid(),
      }),
      z.object({ signatureBase64: z.string().min(1) }),
    ),
  }),
  z.object({
    kind: z.literal("checkpoint-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    reference: z.string().regex(/^[0-9a-f]{64}$/u),
    storedAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal("restore-poll"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    requirement: custodyRestoreRequirementSchema.nullable(),
    reason: z.enum(["required", "no-restore", "restored", "claim-stale"]),
  }),
  z.object({
    kind: z.literal("restore-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    claimId: z.string().min(1),
    custodyEpoch: z.number().int().positive(),
    checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    kind: z.literal("workspace-poll"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    requirement: initialWorkspaceRequirementSchema.nullable(),
    reason: z.enum(["required", "no-workspace", "prepared", "claim-stale"]),
  }),
  z.object({
    kind: z.literal("workspace-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    claimId: z.string().min(1),
    custodyEpoch: z.literal(1),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
  }),
  z.object({
    kind: z.literal("executor-poll"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    command: executorStartCommandSchema.nullable(),
    reason: z.enum([
      "offered",
      "no-command",
      "quota-unavailable",
      "quota-blocked",
      "workspace-required",
      "restore-required",
      "claim-stale",
    ]),
  }),
  z.object({
    kind: z.literal("executor-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    commandId: z.uuid(),
    stage: z.enum(["started", "completed", "interrupted", "failed"]),
    checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  }),
  z.object({
    kind: z.literal("executor-reconcile"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    commandId: z.uuid(),
    action: z.enum(["resume", "quarantine"]),
    reason: z.enum([
      "current",
      "command-stale",
      "claim-stale",
      "workspace-required",
      "restore-required",
      "quota-unavailable",
      "quota-blocked",
    ]),
  }),
  z.object({
    kind: z.literal("validation-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
    stage: z.enum(["awaiting-review", "ready", "blocked"]),
  }),
  z.object({
    kind: z.literal("review-receipt"),
    hostId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    checkpointReference: z.string().regex(/^[0-9a-f]{64}$/u),
    stage: z.enum(["ready", "blocked"]),
  }),
]);

export class HostGatewayClient implements DurableUsageGovernor {
  constructor(
    private readonly gatewayUrl: string,
    private readonly hostId: string,
    private readonly privateKeyPem: string,
    private readonly sequences: SequenceSource,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async heartbeat(input: Omit<HostHeartbeat, "hostId" | "observedAt">): Promise<HostGatewayReceipt> {
    return await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "heartbeat",
      payload: {
        ...input,
        hostId: this.hostId,
        observedAt: this.now().toISOString(),
      },
    });
  }

  async observe(input: {
    readonly observation: RawAccountUsageObservation;
    readonly now: string;
  }): Promise<QuotaDecision> {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: input.now,
      kind: "quota-observation",
      payload: { observation: input.observation },
    });
    if (receipt.kind !== "quota-observation") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    return receipt.decision;
  }

  async requestCheckpointGrant(
    request: CheckpointGrantRequest,
  ): Promise<SignedCheckpointGrant> {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "checkpoint-grant",
      payload: checkpointGrantRequestSchema.parse(request),
    });
    if (receipt.kind !== "checkpoint-grant") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    return receipt.grant;
  }

  async submitCheckpointReceipt(
    input: SignedCheckpointStorageReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "checkpoint-receipt" }>> {
    const stored = signedCheckpointStorageReceiptSchema.parse(input);
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "checkpoint-receipt",
      payload: stored,
    });
    if (receipt.kind !== "checkpoint-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (
      receipt.reference !== stored.reference ||
      receipt.storedAt !== stored.storedAt
    ) {
      throw new Error("Host gateway checkpoint receipt does not match storage proof.");
    }
    return receipt;
  }

  async pollRestore(): Promise<
    Extract<HostGatewayReceipt, { readonly kind: "restore-poll" }>
  > {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "restore-poll",
      payload: {},
    });
    if (receipt.kind !== "restore-poll") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    return receipt;
  }

  async pollWorkspace(): Promise<
    Extract<HostGatewayReceipt, { readonly kind: "workspace-poll" }>
  > {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "workspace-poll",
      payload: {},
    });
    if (receipt.kind !== "workspace-poll") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    return receipt;
  }

  async reportWorkspace(
    input: InitialWorkspaceReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "workspace-receipt" }>> {
    const prepared = initialWorkspaceReceiptSchema.parse(input);
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "workspace-receipt",
      payload: prepared,
    });
    if (receipt.kind !== "workspace-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (
      receipt.claimId !== prepared.claimId ||
      receipt.custodyEpoch !== prepared.custodyEpoch ||
      receipt.baseHead !== prepared.baseHead
    ) {
      throw new Error("Host gateway workspace receipt does not match its request.");
    }
    return receipt;
  }

  async reportRestore(
    input: CustodyRestoreReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "restore-receipt" }>> {
    const restored = custodyRestoreReceiptSchema.parse(input);
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "restore-receipt",
      payload: restored,
    });
    if (receipt.kind !== "restore-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (
      receipt.claimId !== restored.claimId ||
      receipt.custodyEpoch !== restored.custodyEpoch ||
      receipt.checkpointReference !== restored.checkpointReference
    ) {
      throw new Error("Host gateway restore receipt does not match its request.");
    }
    return receipt;
  }

  async reportValidation(
    input: ExactValidationReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "validation-receipt" }>> {
    const validation = exactValidationReceiptSchema.parse(input);
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "validation-receipt",
      payload: validation,
    });
    if (receipt.kind !== "validation-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (
      receipt.checkpointReference !==
      validation.workProduct.checkpointReference
    ) {
      throw new Error("Host gateway validation receipt changes its work product.");
    }
    return receipt;
  }

  async reportReview(
    input: IndependentReviewReceipt,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "review-receipt" }>> {
    const review = independentReviewReceiptSchema.parse(input);
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "review-receipt",
      payload: review,
    });
    if (receipt.kind !== "review-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (receipt.checkpointReference !== review.workProduct.checkpointReference) {
      throw new Error("Host gateway review receipt changes its work product.");
    }
    return receipt;
  }

  async pollExecutor(accountId: string): Promise<
    Extract<HostGatewayReceipt, { readonly kind: "executor-poll" }>
  > {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "executor-poll",
      payload: { accountId },
    });
    if (receipt.kind !== "executor-poll") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    return receipt;
  }

  async reportExecutor(
    input: ExecutorCommandReportInput,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "executor-receipt" }>> {
    const issuedAt = this.now().toISOString();
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt,
      kind: "executor-receipt",
      payload: executorCommandReceiptSchema.parse({ ...input, observedAt: issuedAt }),
    });
    if (receipt.kind !== "executor-receipt") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (
      receipt.commandId !== input.commandId ||
      receipt.stage !== input.stage ||
      (input.stage !== "started" &&
        receipt.checkpointReference !== input.checkpointReference)
    ) {
      throw new Error("Host gateway executor receipt does not match its signed request.");
    }
    return receipt;
  }

  async reconcileExecutor(
    input: ExecutorReconcileRequest,
  ): Promise<Extract<HostGatewayReceipt, { readonly kind: "executor-reconcile" }>> {
    const receipt = await this.#submit({
      schemaVersion: 1,
      hostId: this.hostId,
      sequence: await this.sequences.next(),
      issuedAt: this.now().toISOString(),
      kind: "executor-reconcile",
      payload: executorReconcileRequestSchema.parse(input),
    });
    if (receipt.kind !== "executor-reconcile") {
      throw new Error("Host gateway returned the wrong receipt kind.");
    }
    if (receipt.commandId !== input.commandId) {
      throw new Error("Host gateway reconciliation names another command.");
    }
    if (
      (receipt.action === "resume" && receipt.reason !== "current") ||
      (receipt.action === "quarantine" && receipt.reason === "current")
    ) {
      throw new Error("Host gateway reconciliation action contradicts its reason.");
    }
    return receipt;
  }

  async #submit(unsigned: UnsignedHostEnvelope): Promise<HostGatewayReceipt> {
    const envelope = signHostEnvelope(unsigned, this.privateKeyPem);
    const response = await this.fetchImpl(
      `${this.gatewayUrl.replace(/\/$/u, "")}/HostGateway/${encodeURIComponent(this.hostId)}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `host-${this.hostId}-${unsigned.sequence.toLocaleString("en-US", { useGrouping: false })}-${hostEnvelopeDigest(envelope).slice(0, 16)}`,
        },
        body: JSON.stringify(envelope),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Host gateway returned ${response.status.toLocaleString("en-US", { useGrouping: false })}.`,
      );
    }
    const receipt = gatewayReceiptSchema.parse(await response.json()) as HostGatewayReceipt;
    if (receipt.hostId !== this.hostId || receipt.sequence !== unsigned.sequence) {
      throw new Error("Host gateway receipt does not match its signed request.");
    }
    if (receipt.kind === "heartbeat" && receipt.host.id !== this.hostId) {
      throw new Error("Host gateway heartbeat receipt names another host.");
    }
    return receipt;
  }
}
