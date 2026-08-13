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
  }

  untrack(accountId: string, turnId: string): void {
    const turns = this.#turns.get(accountId);
    turns?.delete(turnId);
    if (turns?.size === 0) {
      this.#turns.delete(accountId);
    }
  }

  async sample(accountId: string): Promise<QuotaMonitorReceipt> {
    const turns = this.#turns.get(accountId) ?? new Map();
    const observation = await this.usageSource.read(accountId, [...turns.keys()]);
    const decision = await this.governor.observe({
      observation,
      now: this.now().toISOString(),
    });
    const interruptedTurnIds: string[] = [];
    if (decision.action === "interrupt") {
      for (const handle of turns.values()) {
        await this.worker.interrupt(handle);
        interruptedTurnIds.push(handle.turnId);
      }
    }
    return { accountId, decision, interruptedTurnIds };
  }
}
