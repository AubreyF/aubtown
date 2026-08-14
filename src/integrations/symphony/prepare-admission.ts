import type { AuthorityBridge } from "../../adapters/authority.js";
import type { ExecutionAdmissionBinding } from "../../adapters/execution-admission.js";
import { accountUsageSnapshotSchema } from "../../domain/schemas.js";
import type { AccountUsageSnapshot, HostLane } from "../../domain/types.js";
import {
  SymphonyAdmissionEnvelopeStore,
  symphonyAdmissionEnvelopeSchema,
  type SymphonyAdmissionEnvelope,
} from "./admission-envelope.js";

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
        preparedAt: input.now,
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
}
