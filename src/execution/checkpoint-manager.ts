import type { CheckpointStore } from "../checkpoints/store.js";
import type { CapturedCheckpoint, GitCustodyCheckpointService } from "../checkpoints/git-custody.js";
import type { SignedCheckpointStorageReceipt } from "../checkpoints/receipt.js";
import { encodeCheckpoint } from "../checkpoints/codec.js";
import type { CheckpointTransferClient } from "../clients/checkpoint-transfer.js";
import type { HostGatewayClient } from "../clients/host-gateway.js";
import type { ExecutorStartCommand } from "./command.js";

export type TerminalExecutionStatus = "completed" | "interrupted" | "failed";

export interface ExecutionCheckpointManager {
  capture(input: {
    readonly command: ExecutorStartCommand;
    readonly status: TerminalExecutionStatus;
    readonly createdAt: string;
  }): Promise<CapturedCheckpoint>;
  upload(input: {
    readonly command: ExecutorStartCommand;
    readonly checkpoint: CapturedCheckpoint;
  }): Promise<SignedCheckpointStorageReceipt>;
  catalog(receipt: SignedCheckpointStorageReceipt): Promise<void>;
}

export class RemoteExecutionCheckpointManager implements ExecutionCheckpointManager {
  constructor(
    private readonly custody: GitCustodyCheckpointService,
    private readonly localStore: CheckpointStore,
    private readonly transfer: CheckpointTransferClient,
    private readonly gateway: Pick<
      HostGatewayClient,
      "requestCheckpointGrant" | "submitCheckpointReceipt"
    >,
    private readonly keyReference: string,
  ) {}

  async capture(input: {
    readonly command: ExecutorStartCommand;
    readonly status: TerminalExecutionStatus;
    readonly createdAt: string;
  }): Promise<CapturedCheckpoint> {
    return await this.custody.capture({
      claim: input.command.claim,
      repositoryRoot: input.command.repositoryRoot,
      baseRef: `origin/${input.command.claim.repository.defaultBranch}`,
      validationReceipts: [`worker-turn:${input.status}`],
      keyReference: this.keyReference,
      createdAt: input.createdAt,
    });
  }

  async upload(input: {
    readonly command: ExecutorStartCommand;
    readonly checkpoint: CapturedCheckpoint;
  }): Promise<SignedCheckpointStorageReceipt> {
    const payload = await this.localStore.get(input.checkpoint.reference);
    if (payload === undefined) {
      throw new Error("Captured checkpoint is missing from the host-local store.");
    }
    if (
      payload.manifest.claimId !== input.command.claim.claimId ||
      payload.manifest.custodyEpoch !== input.command.claim.custodyEpoch
    ) {
      throw new Error("Captured checkpoint does not match the execution command.");
    }
    const contentLength = encodeCheckpoint(payload).length;
    const grant = await this.gateway.requestCheckpointGrant({
      repository: input.command.claim.repository,
      issueNumber: input.command.claim.issueNumber,
      claimId: input.command.claim.claimId,
      custodyEpoch: input.command.claim.custodyEpoch,
      checkpointEpoch: payload.manifest.custodyEpoch,
      operation: "upload",
      reference: input.checkpoint.reference,
      contentLength,
    });
    return await this.transfer.upload(payload, grant);
  }

  async catalog(receipt: SignedCheckpointStorageReceipt): Promise<void> {
    await this.gateway.submitCheckpointReceipt(receipt);
  }
}
