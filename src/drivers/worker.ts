import type {
  DispatchClaim,
  QualificationReport,
  RawAccountUsageObservation,
} from "../domain/types.js";

export interface WorkerCapabilities {
  readonly hostLanes: readonly ("linux" | "macos")[];
  readonly canInterrupt: boolean;
  readonly canReadSubscriptionUsage: boolean;
  readonly publicationCeiling: "none" | "draft-pr";
}

export interface WorkerTurnRequest {
  readonly claim: DispatchClaim;
  readonly qualification: QualificationReport;
  readonly prompt: string;
  readonly repositoryRoot: string;
}

export interface WorkerTurnHandle {
  readonly driverId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly startedAt: string;
}

export interface WorkerDriver {
  readonly id: string;
  readonly capabilities: WorkerCapabilities;
  start(request: WorkerTurnRequest): Promise<WorkerTurnHandle>;
  recover(
    handle: WorkerTurnHandle,
    repositoryRoot: string,
  ): Promise<"running" | "completed" | "interrupted" | "failed">;
  wait(handle: WorkerTurnHandle): Promise<"completed" | "interrupted" | "failed">;
  interrupt(handle: WorkerTurnHandle): Promise<void>;
}

export interface UsageSource {
  readonly id: string;
  read(
    accountId: string,
    activeTurnIds: readonly string[],
  ): Promise<RawAccountUsageObservation>;
}
