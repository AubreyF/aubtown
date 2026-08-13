import type { RawAccountUsageObservation } from "../domain/types.js";
import type { QuotaDecision } from "../policy/quota.js";
import type { DurableUsageGovernor } from "../supervision/quota-monitor.js";

export class RestateUsageGovernorClient implements DurableUsageGovernor {
  constructor(
    private readonly ingress: string,
    private readonly accountId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async observe(input: {
    readonly observation: RawAccountUsageObservation;
    readonly now: string;
  }): Promise<QuotaDecision> {
    if (input.observation.accountId !== this.accountId) {
      throw new Error("Usage observation account does not match governor client.");
    }
    const response = await this.fetchImpl(
      `${this.ingress.replace(/\/$/u, "")}/AccountGovernor/${encodeURIComponent(this.accountId)}/observe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Restate governor returned ${response.status.toLocaleString("en-US", { useGrouping: false })}.`,
      );
    }
    return (await response.json()) as QuotaDecision;
  }
}
