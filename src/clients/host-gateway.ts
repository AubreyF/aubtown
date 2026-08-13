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
  executorStartCommandSchema,
  type ExecutorCommandReceipt,
} from "../execution/command.js";

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
    input: Omit<ExecutorCommandReceipt, "observedAt">,
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
    if (receipt.commandId !== input.commandId || receipt.stage !== input.stage) {
      throw new Error("Host gateway executor receipt does not match its signed request.");
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
