import type { RawAccountUsageObservation } from "../domain/types.js";
import type {
  UsageSource,
  WorkerDriver,
  WorkerTurnHandle,
} from "../drivers/worker.js";
import type { QuotaDecision } from "../policy/quota.js";

export interface DurableUsageGovernor {
  observe(input: {
    readonly observation: RawAccountUsageObservation;
    readonly now: string;
  }): Promise<QuotaDecision>;
}

export interface QuotaMonitorReceipt {
  readonly accountId: string;
  readonly decision: QuotaDecision;
  readonly interruptedTurnIds: readonly string[];
}

export class QuotaMonitor {
  readonly #turns = new Map<string, Map<string, WorkerTurnHandle>>();
  readonly #lastSuccessfulSample = new Map<string, number>();
  readonly #interruptedTurns = new Set<string>();

  constructor(
    private readonly usageSource: UsageSource,
    private readonly worker: WorkerDriver,
    private readonly governor: DurableUsageGovernor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  track(accountId: string, handle: WorkerTurnHandle): void {
    const turns = this.#turns.get(accountId) ?? new Map();
    turns.set(handle.turnId, handle);
    this.#turns.set(accountId, turns);
    this.#interruptedTurns.delete(handle.turnId);
  }

  untrack(accountId: string, turnId: string): void {
    const turns = this.#turns.get(accountId);
    turns?.delete(turnId);
    if (turns?.size === 0) {
      this.#turns.delete(accountId);
    }
    this.#interruptedTurns.delete(turnId);
  }

  async sample(accountId: string): Promise<QuotaMonitorReceipt> {
    const turns = this.#turns.get(accountId) ?? new Map();
    const observation = await this.usageSource.read(accountId, [...turns.keys()]);
    const sampledAt = this.now();
    const decision = await this.governor.observe({
      observation,
      now: sampledAt.toISOString(),
    });
    this.#lastSuccessfulSample.set(accountId, sampledAt.getTime());
    const interruptedTurnIds: string[] = [];
    if (decision.action === "interrupt") {
      for (const handle of turns.values()) {
        if (await this.#interrupt(handle)) {
          interruptedTurnIds.push(handle.turnId);
        }
      }
    }
    return { accountId, decision, interruptedTurnIds };
  }

  async enforceTelemetryFreshness(
    accountId: string,
    maxAgeSeconds: number,
  ): Promise<readonly string[]> {
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new RangeError("Telemetry maximum age must be positive.");
    }
    const lastSuccessful = this.#lastSuccessfulSample.get(accountId);
    if (
      lastSuccessful !== undefined &&
      this.now().getTime() - lastSuccessful <= maxAgeSeconds * 1_000
    ) {
      return [];
    }
    const interrupted: string[] = [];
    for (const handle of this.#turns.get(accountId)?.values() ?? []) {
      if (await this.#interrupt(handle)) {
        interrupted.push(handle.turnId);
      }
    }
    return interrupted;
  }

  async #interrupt(handle: WorkerTurnHandle): Promise<boolean> {
    if (this.#interruptedTurns.has(handle.turnId)) {
      return false;
    }
    await this.worker.interrupt(handle);
    this.#interruptedTurns.add(handle.turnId);
    return true;
  }
}
