import { createHash } from "node:crypto";
import type {
  FreedClaimReleaseReceipt,
  FreedClaimReleaseRequest,
} from "../adapters/freed/claim-broker.js";
import type { RemoteDraftPublisher } from "../publication/remote-runner.js";
import type { PublicationPlan } from "../publication/policy.js";
import type {
  ProjectionWriteReceipt,
} from "../projection/github-writer.js";
import type { StatusProjection } from "../projection/status.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  PublicationTransactionStore,
  type PublicationTransaction,
} from "./publication-transaction.js";

export interface LifecycleProjectionWriter {
  write(input: {
    readonly owner: string;
    readonly repository: string;
    readonly issueNumber: number;
    readonly projection: StatusProjection;
    readonly projectionApproved: boolean;
  }): Promise<ProjectionWriteReceipt>;
}

export interface CompletedClaimReleaser {
  release(request: FreedClaimReleaseRequest): Promise<FreedClaimReleaseReceipt>;
}

export interface CompletedClaimReleaseContext {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly authorityClaimId: string;
  readonly bindingDigest: string;
  readonly custodyEpoch: number;
  readonly expectedHeartbeatAt: string;
  readonly releasedAt: string;
}

function deterministicUuid(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function bindPublishedDraftProjection(
  plan: PublicationPlan,
  pullRequestNumber: number,
): StatusProjection {
  const projection = plan.projection;
  if (projection === undefined || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("Published draft lacks an admitted lifecycle projection.");
  }
  const expected = `#${pullRequestNumber.toLocaleString("en-US", {
    useGrouping: false,
  })}`;
  const line = /^Draft pull request: (.+)$/mu;
  const match = projection.commentBody.match(line);
  if (match === null || (match[1] !== "pending creation" && match[1] !== expected)) {
    throw new Error("Lifecycle projection names another draft pull request.");
  }
  return {
    labelsToAdd: [...projection.labelsToAdd],
    labelsToRemove: [...projection.labelsToRemove],
    commentBody: projection.commentBody.replace(line, `Draft pull request: ${expected}`),
  };
}

export class DurablePublicationCoordinator {
  constructor(
    private readonly transactions: PublicationTransactionStore,
    private readonly publisher: RemoteDraftPublisher,
    private readonly projections: LifecycleProjectionWriter,
    private readonly claims: CompletedClaimReleaser,
  ) {}

  async run(input: {
    readonly plan: PublicationPlan;
    readonly projectionApproved: boolean;
    readonly release?: CompletedClaimReleaseContext;
  }): Promise<PublicationTransaction> {
    let transaction = await this.transactions.recordPlan(input.plan);
    if (!input.projectionApproved && transaction.projection === undefined) {
      throw new Error(
        "Draft publication requires the lifecycle projection pilot gate.",
      );
    }
    if (transaction.publication === undefined) {
      const receipt = await this.publisher.publish(transaction.plan);
      transaction = await this.transactions.recordPublication(
        transaction.checkpointReference,
        receipt,
      );
    }
    if (transaction.projection === undefined) {
      const repository = transaction.plan.repository;
      const workProduct = transaction.plan.workProduct;
      const publication = transaction.publication;
      if (
        repository === undefined ||
        workProduct === undefined ||
        publication === undefined
      ) {
        throw new Error("Published transaction lost its admitted identity.");
      }
      const [owner, name, extra] = repository.split("/");
      if (owner === undefined || name === undefined || extra !== undefined) {
        throw new Error("Published transaction repository is malformed.");
      }
      const receipt = await this.projections.write({
        owner,
        repository: name,
        issueNumber: workProduct.issueNumber,
        projection: bindPublishedDraftProjection(
          transaction.plan,
          publication.pullRequestNumber,
        ),
        projectionApproved: input.projectionApproved,
      });
      transaction = await this.transactions.recordProjection(
        transaction.checkpointReference,
        receipt,
      );
    }
    if (transaction.releaseCommand === undefined) {
      if (input.release === undefined) {
        throw new Error("Published transaction lacks current claim cleanup evidence.");
      }
      const command: FreedClaimReleaseRequest = {
        schemaVersion: 1,
        operationId: deterministicUuid({
          domain: "aubtown.completed-claim-release.v1",
          checkpointReference: transaction.checkpointReference,
          taskId: input.release.taskId,
          authorityClaimId: input.release.authorityClaimId,
        }),
        taskId: input.release.taskId,
        expectedTaskRevision: input.release.taskRevision,
        authorityClaimId: input.release.authorityClaimId,
        bindingDigest: input.release.bindingDigest,
        custodyEpoch: input.release.custodyEpoch,
        expectedHeartbeatAt: input.release.expectedHeartbeatAt,
        reason: "worker-completed",
        releasedAt: input.release.releasedAt,
      };
      transaction = await this.transactions.recordReleaseCommand(
        transaction.checkpointReference,
        command,
      );
    }
    if (transaction.release === undefined) {
      const receipt = await this.claims.release(transaction.releaseCommand!);
      transaction = await this.transactions.recordRelease(
        transaction.checkpointReference,
        receipt,
      );
    }
    return transaction;
  }
}
