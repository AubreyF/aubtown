import * as restate from "@restatedev/restate-sdk";
import type {
  ClaimTransferRequest,
  DispatchClaim,
} from "../domain/types.js";
import type { ReconciliationSnapshot } from "../policy/reconciliation.js";
import { claimRegistry } from "./claim-registry.js";
import {
  custodyTransferWorkflow,
  type CustodyTransferInput,
} from "./custody-transfer-workflow.js";
import {
  dryRunWorkflow,
  type DryRunInput,
} from "./dry-run-workflow.js";
import {
  qualificationWorkflow,
  type QualificationWorkflowInput,
} from "./qualification-workflow.js";
import { reconciliationWorkflow } from "./reconciliation-workflow.js";
import { executorCommandRegistry } from "./executor-command-registry.js";
import type {
  ExecutorCommandReceipt,
  ExecutorStartCommand,
} from "../execution/command.js";
import {
  hostRegistry,
  type HostHeartbeat,
} from "./host-registry.js";
import {
  schedulerRegistry,
  type SchedulerAcquireInput,
} from "./scheduler-registry.js";

interface KeyedInput<T> {
  readonly key: string;
  readonly input: T;
}

interface KeyOnlyInput {
  readonly key: string;
}

interface ClaimInput extends KeyOnlyInput {
  readonly claim: DispatchClaim;
}

interface ClaimReleaseInput extends KeyOnlyInput {
  readonly expected: {
    readonly claimId: string;
    readonly custodyEpoch: number;
  };
}

interface ClaimTransferInput extends KeyOnlyInput {
  readonly request: ClaimTransferRequest;
}

interface ExecutorCommandInput extends KeyOnlyInput {
  readonly command: ExecutorStartCommand;
}

interface ExecutorTransferInput extends KeyOnlyInput {
  readonly claimId: string;
  readonly custodyEpoch: number;
  readonly preparedAt: string;
}

interface ExecutorOfferInput extends KeyOnlyInput {
  readonly commandId: string;
  readonly offeredAt: string;
}

interface ExecutorRecordInput extends KeyOnlyInput {
  readonly receipt: ExecutorCommandReceipt;
  readonly acceptedAt: string;
}

interface HostHeartbeatInput extends KeyOnlyInput {
  readonly heartbeat: HostHeartbeat;
}

/**
 * Local integration ingress for black-box tests. Production never binds this
 * service. All durable factory services remain ingress-private.
 */
export const integrationHarness = restate.service({
  name: "IntegrationHarness",
  handlers: {
    runDryRun: async (ctx: restate.Context, request: KeyedInput<DryRunInput>) =>
      await ctx.workflowClient(dryRunWorkflow, request.key).run(request.input),
    runQualification: async (
      ctx: restate.Context,
      request: KeyedInput<QualificationWorkflowInput>,
    ) =>
      await ctx.workflowClient(qualificationWorkflow, request.key).run(request.input),
    runCustodyTransfer: async (
      ctx: restate.Context,
      request: KeyedInput<CustodyTransferInput>,
    ) =>
      await ctx
        .workflowClient(custodyTransferWorkflow, request.key)
        .run(request.input),
    runReconciliation: async (
      ctx: restate.Context,
      request: KeyedInput<ReconciliationSnapshot>,
    ) =>
      await ctx
        .workflowClient(reconciliationWorkflow, request.key)
        .run(request.input),
    claim: async (ctx: restate.Context, request: ClaimInput) =>
      await ctx.objectClient(claimRegistry, request.key).claim(request.claim),
    readClaim: async (ctx: restate.Context, request: KeyOnlyInput) =>
      await ctx.objectClient(claimRegistry, request.key).read(),
    releaseClaim: async (ctx: restate.Context, request: ClaimReleaseInput) =>
      await ctx.objectClient(claimRegistry, request.key).release(request.expected),
    transferClaim: async (ctx: restate.Context, request: ClaimTransferInput) =>
      await ctx.objectClient(claimRegistry, request.key).transfer(request.request),
    acquireScheduler: async (
      ctx: restate.Context,
      request: KeyedInput<SchedulerAcquireInput>,
    ) =>
      await ctx.objectClient(schedulerRegistry, request.key).acquire(request.input),
    readScheduler: async (ctx: restate.Context, request: KeyOnlyInput) =>
      await ctx.objectClient(schedulerRegistry, request.key).read(),
    releaseScheduler: async (ctx: restate.Context, request: ClaimReleaseInput) =>
      await ctx.objectClient(schedulerRegistry, request.key).release(request.expected),
    transferScheduler: async (ctx: restate.Context, request: ClaimTransferInput) =>
      await ctx.objectClient(schedulerRegistry, request.key).transfer(request.request),
    enqueueExecutorCommand: async (
      ctx: restate.Context,
      request: ExecutorCommandInput,
    ) =>
      await ctx
        .objectClient(executorCommandRegistry, request.key)
        .enqueue(request.command),
    readExecutorCommand: async (ctx: restate.Context, request: KeyOnlyInput) =>
      await ctx.objectClient(executorCommandRegistry, request.key).read(),
    offerExecutorCommand: async (
      ctx: restate.Context,
      request: ExecutorOfferInput,
    ) =>
      await ctx.objectClient(executorCommandRegistry, request.key).offer({
        commandId: request.commandId,
        offeredAt: request.offeredAt,
      }),
    recordExecutorCommand: async (
      ctx: restate.Context,
      request: ExecutorRecordInput,
    ) =>
      await ctx.objectClient(executorCommandRegistry, request.key).record({
        receipt: request.receipt,
        acceptedAt: request.acceptedAt,
      }),
    prepareExecutorTransfer: async (
      ctx: restate.Context,
      request: ExecutorTransferInput,
    ) =>
      await ctx.objectClient(executorCommandRegistry, request.key).prepareTransfer({
        claimId: request.claimId,
        custodyEpoch: request.custodyEpoch,
        preparedAt: request.preparedAt,
      }),
    releaseExecutorTransfer: async (
      ctx: restate.Context,
      request: ExecutorTransferInput,
    ) =>
      await ctx.objectClient(executorCommandRegistry, request.key).releaseTransfer({
        claimId: request.claimId,
        custodyEpoch: request.custodyEpoch,
      }),
    heartbeatHost: async (
      ctx: restate.Context,
      request: HostHeartbeatInput,
    ) => await ctx.objectClient(hostRegistry, request.key).heartbeat(request.heartbeat),
  },
});
