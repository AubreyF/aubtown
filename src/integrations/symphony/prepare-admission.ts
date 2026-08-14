import type { AuthorityBridge } from "../../adapters/authority.js";
import type { ExecutionAdmissionBinding } from "../../adapters/execution-admission.js";
import {
  accountUsageSnapshotSchema,
  qualificationReportSchema,
} from "../../domain/schemas.js";
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
import {
  createWorkspaceFinalizationNonce,
  workspaceRequirementFromBinding,
  type InitialWorkspacePreparer,
  type InitialWorkspaceRequirement,
} from "../../execution/workspace.js";

export function symphonyWorkspaceRequirementFromBinding(input: {
  readonly binding: ExecutionAdmissionBinding;
  readonly requiredAt: string;
}): InitialWorkspaceRequirement {
  const binding = input.binding;
  if (binding.claim.custodyEpoch !== 1) {
    throw new Error("Initial Symphony workspace requires custody epoch one.");
  }
  const nonceInput = {
    repository: binding.qualification.repository,
    issueNumber: binding.qualification.issue.number,
    claimId: binding.claim.claimId,
    custodyEpoch: 1 as const,
    hostId: binding.claim.hostId,
    workerId: binding.claim.workerId,
    worktree: binding.claim.worktree,
    branch: binding.claim.branch,
    authorityTaskId: binding.authorityTask.id,
    authorityTaskRevision: binding.authorityTask.revision,
    accountId: binding.accountId,
    driverId: binding.driverId,
    baseHead: binding.baseHead,
  };
  return workspaceRequirementFromBinding({
    repository: binding.qualification.repository,
    issueNumber: binding.qualification.issue.number,
    claimId: binding.claim.claimId,
    custodyEpoch: 1,
    hostId: binding.claim.hostId,
    workerId: binding.claim.workerId,
    worktree: binding.claim.worktree,
    branch: binding.claim.branch,
    conflictDomains: binding.claim.conflictDomains,
    claimedAt: binding.claim.claimedAt,
    baseHead: binding.baseHead,
    target: binding.target,
    handoff: {
      qualification: qualificationReportSchema.parse(binding.qualification),
      authorityTaskId: binding.authorityTask.id,
      authorityTaskRevision: binding.authorityTask.revision,
      accountId: binding.accountId,
      driverId: binding.driverId,
      publicationCeiling: "draft-pr",
      finalizationNonce: createWorkspaceFinalizationNonce(nonceInput),
    },
    requiredAt: input.requiredAt,
  });
}

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
    private readonly workspaces: InitialWorkspacePreparer,
  ) {}

  async #prepareWorkspace(input: {
    readonly binding: ExecutionAdmissionBinding;
    readonly now: string;
  }): Promise<void> {
    await this.workspaces.prepare(
      symphonyWorkspaceRequirementFromBinding({
        binding: input.binding,
        requiredAt: input.now,
      }),
    );
  }

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
      await this.#prepareWorkspace({ binding: input.binding, now: input.now });
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
      await this.#prepareWorkspace({
        binding: candidate.binding,
        now: input.now,
      });
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
