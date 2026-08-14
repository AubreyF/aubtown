import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  accountUsageSnapshotSchema,
} from "../domain/schemas.js";
import type {
  AccountUsageSnapshot,
  HostRecord,
  RawAccountUsageObservation,
} from "../domain/types.js";
import type { HostGatewayReceipt } from "./receipt.js";
import { decideQuota, mergeUsageObservation } from "../policy/quota.js";
import type { HostEnrollments } from "../security/host-enrollment.js";
import {
  hostEnvelopeDigest,
  parseSignedHostEnvelope,
  type SignedHostEnvelope,
  verifyHostEnvelope,
} from "../security/host-envelope.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_AGE_SECONDS = 120;
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);

const hostRecordSchema: z.ZodType<HostRecord> = z.object({
  id: identifierSchema,
  lane: z.enum(["linux", "macos"]),
  online: z.boolean(),
  lastHeartbeatAt: z.iso.datetime(),
  activeClaims: z.array(z.string().min(1)),
  accountIds: z.array(identifierSchema),
});

const quotaDecisionSchema = z.object({
  action: z.enum(["admit", "throttle", "stop-admission", "interrupt"]),
  reason: z.enum([
    "headroom-available",
    "telemetry-stale",
    "weekly-ceiling",
    "daily-meter-diverged",
    "daily-throttle",
    "daily-admission-stop",
    "daily-interrupt",
  ]),
  weeklyUsedPercent: z.number().min(0).max(100),
  dailyUsedPercent: z.number().min(0),
  observedAt: z.iso.datetime(),
});

const observationReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heartbeat"),
    hostId: identifierSchema,
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    host: hostRecordSchema,
  }),
  z.object({
    kind: z.literal("quota-observation"),
    hostId: identifierSchema,
    sequence: z.number().int().positive().safe(),
    acceptedAt: z.iso.datetime(),
    decision: quotaDecisionSchema,
  }),
]);

type ObservationReceipt = z.infer<typeof observationReceiptSchema>;

const hostSequenceSchema = z.object({
  sequence: z.number().int().positive().safe(),
  envelopeDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  receipt: observationReceiptSchema,
});

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  updatedAt: z.iso.datetime().nullable(),
  hostSequences: z.record(identifierSchema, hostSequenceSchema),
  hosts: z.record(identifierSchema, hostRecordSchema),
  usageByAccountId: z.record(identifierSchema, accountUsageSnapshotSchema),
});

type HostObservationState = z.infer<typeof stateSchema>;

export interface HostObservationSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly observedAt: string | null;
  readonly hosts: readonly HostRecord[];
  readonly usageByAccountId: Readonly<Record<string, AccountUsageSnapshot>>;
}

export interface HostObservationAcceptance {
  readonly receipt: Extract<
    HostGatewayReceipt,
    { readonly kind: "heartbeat" | "quota-observation" }
  >;
  readonly acceptedNow: boolean;
}

function emptyState(): HostObservationState {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: null,
    hostSequences: {},
    hosts: {},
    usageByAccountId: {},
  };
}

function rawObservation(snapshot: AccountUsageSnapshot): RawAccountUsageObservation {
  return {
    accountId: snapshot.accountId,
    observedAt: snapshot.observedAt,
    primary: snapshot.primary,
    lifetimeTokens: snapshot.dailyConsumption.observedLifetimeTokens,
    activeTurnIds: snapshot.activeTurnIds,
  };
}

export class HostObservationJournal {
  #pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly enrollments: HostEnrollments,
  ) {
    if (!path.isAbsolute(file)) {
      throw new Error("Host observation journal path must be absolute.");
    }
  }

  accept(
    value: SignedHostEnvelope,
    acceptedAt: string,
  ): Promise<HostObservationAcceptance> {
    return this.#serialize(async () => {
      const envelope = parseSignedHostEnvelope(value);
      if (envelope.kind !== "heartbeat" && envelope.kind !== "quota-observation") {
        throw new Error("Host observation journal accepts only heartbeat and quota envelopes.");
      }
      const enrollment = this.enrollments[envelope.hostId];
      if (enrollment === undefined || !enrollment.enabled) {
        throw new Error("Host is not enabled in the coordinator enrollment set.");
      }
      if (!verifyHostEnvelope(envelope, enrollment.publicKeyPem)) {
        throw new Error("Host envelope signature is invalid.");
      }
      const acceptedAtMs = Date.parse(acceptedAt);
      const issuedAtMs = Date.parse(envelope.issuedAt);
      const envelopeAgeSeconds = (acceptedAtMs - issuedAtMs) / 1_000;
      if (
        !Number.isFinite(envelopeAgeSeconds) ||
        Math.abs(envelopeAgeSeconds) > MAX_ENVELOPE_AGE_SECONDS
      ) {
        throw new Error("Host envelope is stale or temporally invalid.");
      }

      const current = await this.#read();
      const priorSequence = current.hostSequences[envelope.hostId];
      const digest = hostEnvelopeDigest(envelope);
      if (priorSequence !== undefined && envelope.sequence <= priorSequence.sequence) {
        if (
          envelope.sequence === priorSequence.sequence &&
          digest === priorSequence.envelopeDigest
        ) {
          return {
            receipt: priorSequence.receipt as HostObservationAcceptance["receipt"],
            acceptedNow: false,
          };
        }
        throw new Error("Host envelope sequence is stale or conflicting.");
      }
      if (
        current.updatedAt !== null &&
        acceptedAtMs < Date.parse(current.updatedAt)
      ) {
        throw new Error("Coordinator observation time cannot move backward.");
      }

      let receipt: ObservationReceipt;
      let next: HostObservationState;
      if (envelope.kind === "heartbeat") {
        receipt = this.#acceptHeartbeat(envelope, enrollment, acceptedAt);
        next = stateSchema.parse({
          ...current,
          revision: current.revision + 1,
          updatedAt: acceptedAt,
          hostSequences: {
            ...current.hostSequences,
            [envelope.hostId]: {
              sequence: envelope.sequence,
              envelopeDigest: digest,
              receipt,
            },
          },
          hosts: { ...current.hosts, [envelope.hostId]: receipt.host },
        });
      } else {
        receipt = this.#acceptQuota(envelope, enrollment, current, acceptedAt);
        const observation = envelope.payload.observation;
        next = stateSchema.parse({
          ...current,
          revision: current.revision + 1,
          updatedAt: acceptedAt,
          hostSequences: {
            ...current.hostSequences,
            [envelope.hostId]: {
              sequence: envelope.sequence,
              envelopeDigest: digest,
              receipt,
            },
          },
          usageByAccountId: {
            ...current.usageByAccountId,
            [observation.accountId]: this.#mergedUsage(
              observation,
              current.usageByAccountId[observation.accountId],
            ),
          },
        });
      }
      await this.#write(next);
      return {
        receipt: receipt as HostObservationAcceptance["receipt"],
        acceptedNow: true,
      };
    });
  }

  snapshot(): Promise<HostObservationSnapshot> {
    return this.#serialize(async () => {
      const state = await this.#read();
      return {
        schemaVersion: 1,
        revision: state.revision,
        observedAt: state.updatedAt,
        hosts: Object.values(state.hosts).sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        usageByAccountId: Object.fromEntries(
          Object.entries(state.usageByAccountId).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      };
    });
  }

  #acceptHeartbeat(
    envelope: Extract<SignedHostEnvelope, { readonly kind: "heartbeat" }>,
    enrollment: HostEnrollments[string],
    acceptedAt: string,
  ): Extract<ObservationReceipt, { readonly kind: "heartbeat" }> {
    if (
      envelope.payload.hostId !== envelope.hostId ||
      envelope.payload.lane !== enrollment.lane ||
      envelope.payload.accountIds.some(
        (accountId) => !enrollment.accountIds.includes(accountId),
      )
    ) {
      throw new Error("Heartbeat exceeds its enrolled host scope.");
    }
    return observationReceiptSchema.parse({
      kind: "heartbeat",
      hostId: envelope.hostId,
      sequence: envelope.sequence,
      acceptedAt,
      host: {
        id: envelope.hostId,
        lane: envelope.payload.lane,
        online: true,
        lastHeartbeatAt: envelope.payload.observedAt,
        activeClaims: [...new Set(envelope.payload.activeClaims)].sort(),
        accountIds: [...new Set(envelope.payload.accountIds)].sort(),
      },
    }) as Extract<ObservationReceipt, { readonly kind: "heartbeat" }>;
  }

  #acceptQuota(
    envelope: Extract<SignedHostEnvelope, { readonly kind: "quota-observation" }>,
    enrollment: HostEnrollments[string],
    current: HostObservationState,
    acceptedAt: string,
  ): Extract<ObservationReceipt, { readonly kind: "quota-observation" }> {
    const observation = envelope.payload.observation;
    if (!enrollment.accountIds.includes(observation.accountId)) {
      throw new Error("Quota observation exceeds its enrolled account scope.");
    }
    const merged = this.#mergedUsage(
      observation,
      current.usageByAccountId[observation.accountId],
    );
    return observationReceiptSchema.parse({
      kind: "quota-observation",
      hostId: envelope.hostId,
      sequence: envelope.sequence,
      acceptedAt,
      decision: decideQuota({ snapshot: merged, now: acceptedAt }),
    }) as Extract<ObservationReceipt, { readonly kind: "quota-observation" }>;
  }

  #mergedUsage(
    observation: RawAccountUsageObservation,
    previous: AccountUsageSnapshot | undefined,
  ): AccountUsageSnapshot {
    if (previous !== undefined) {
      const order = Date.parse(observation.observedAt) - Date.parse(previous.observedAt);
      if (order < 0) {
        throw new Error("Quota observation is older than the account snapshot.");
      }
      if (order === 0) {
        if (!canonicalJsonEqual(rawObservation(previous), observation)) {
          throw new Error("Quota observation conflicts at the same timestamp.");
        }
        return previous;
      }
    }
    return accountUsageSnapshotSchema.parse(
      mergeUsageObservation({
        ...(previous === undefined ? {} : { previous }),
        observation,
      }),
    );
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }

  async #read(): Promise<HostObservationState> {
    try {
      const stats = await lstat(this.file);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size < 1 ||
        stats.size > MAX_JOURNAL_BYTES ||
        (stats.mode & 0o077) !== 0
      ) {
        throw new Error("Host observation journal must be a protected physical file.");
      }
      return stateSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return emptyState();
      }
      throw error;
    }
  }

  async #write(state: HostObservationState): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Host observation journal parent must be a physical directory.");
    }
    await chmod(directory, 0o700);
    const temporary = path.join(
      directory,
      `.${path.basename(this.file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
