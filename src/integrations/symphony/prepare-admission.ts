import type { AuthorityBridge } from "../../adapters/authority.js";
import type { ExecutionAdmissionBinding } from "../../adapters/execution-admission.js";
import { accountUsageSnapshotSchema } from "../../domain/schemas.js";
import type { AccountUsageSnapshot, HostLane } from "../../domain/types.js";
import {
  SymphonyAdmissionEnvelopeStore,
  symphonyAdmissionCandidateSchema,
  symphonyAdmissionEnvelopeSchema,
  type SymphonyAdmissionCandidate,
  type SymphonyAdmissionEnvelope,
} from "./admission-envelope.js";
import { canonicalJson } from "../../security/canonical-json.js";
import { prepareSymphonyAdmissionCandidate } from "./admission-candidate.js";

export function symphonyEnvelopeMatchesCandidate(input: {
  readonly envelope: SymphonyAdmissionEnvelope;
  readonly candidate: SymphonyAdmissionCandidate;
}): boolean {
  const envelope = symphonyAdmissionEnvelopeSchema.parse(input.envelope);
  const candidate = symphonyAdmissionCandidateSchema.parse(input.candidate);
  return Buffer.from(
    canonicalJson({
      schemaVersion: envelope.schemaVersion,
      preparedAt: envelope.preparedAt,
      selectedHost: envelope.selectedHost,
      usage: envelope.usage,
      binding: envelope.binding,
    }),
  ).equals(canonicalJson(candidate));
}

export class SymphonyAdmissionPreparer {
  constructor(
    private readonly authority: AuthorityBridge,
    private readonly envelopes: SymphonyAdmissionEnvelopeStore,
  ) {}

  async prepare(input: {
    readonly binding: ExecutionAdmissionBinding;
    readonly selectedHost: {
      readonly id: string;
      readonly lane: HostLane;
    };
    readonly usage: AccountUsageSnapshot;
    readonly now: string;
    readonly preparedAt?: string;
  }): Promise<SymphonyAdmissionEnvelope> {
    const usage = accountUsageSnapshotSchema.parse(input.usage);
    if (
      input.selectedHost.id !== input.binding.claim.hostId ||
      usage.accountId !== input.binding.accountId ||
      (input.binding.qualification.hostLane === "macos" &&
        input.selectedHost.lane !== "macos")
    ) {
      throw new Error(
        "Symphony admission preparation does not match the selected claim route.",
      );
    }
    const admission = await this.authority.acquire({
      binding: input.binding,
      now: input.now,
    });
    try {
      const envelope = symphonyAdmissionEnvelopeSchema.parse({
        schemaVersion: 1,
        preparedAt: input.preparedAt ?? input.now,
        selectedHost: input.selectedHost,
        usage,
        binding: input.binding,
        admission,
      });
      await this.envelopes.publish(envelope);
      return envelope;
    } catch (publicationError) {
      try {
        await this.authority.release({
          admission,
          reason: "prelaunch-denied",
          now: input.now,
        });
      } catch (releaseError) {
        throw new AggregateError(
          [publicationError, releaseError],
          "Symphony admission publication failed and exact claim release also failed.",
        );
      }
      throw publicationError;
    }
  }

  async resolve(input: {
    readonly candidate: SymphonyAdmissionCandidate;
    readonly currentEnvelope?: SymphonyAdmissionEnvelope;
    readonly now: string;
  }): Promise<SymphonyAdmissionEnvelope> {
    const candidate = prepareSymphonyAdmissionCandidate(
      input.candidate,
      input.now,
    );
    if (
      input.currentEnvelope !== undefined &&
      symphonyEnvelopeMatchesCandidate({
        envelope: input.currentEnvelope,
        candidate,
      })
    ) {
      return symphonyAdmissionEnvelopeSchema.parse(input.currentEnvelope);
    }
    return await this.prepare({
      binding: candidate.binding,
      selectedHost: candidate.selectedHost,
      usage: candidate.usage,
      now: input.now,
      preparedAt: candidate.preparedAt,
    });
  }
}
