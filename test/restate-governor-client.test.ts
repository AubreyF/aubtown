import { describe, expect, it } from "vitest";
import type { RawAccountUsageObservation } from "../src/domain/types.js";
import { RestateUsageGovernorClient } from "../src/clients/restate-governor.js";

const observation: RawAccountUsageObservation = {
  accountId: "codex/pro 1",
  observedAt: "2026-08-13T18:00:00.000Z",
  primary: {
    usedPercent: 40,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-08-18T08:00:00.000Z",
  },
  activeTurnIds: [],
};

describe("RestateUsageGovernorClient", () => {
  it("submits observations to the encoded account object key", async () => {
    let requestedUrl = "";
    const client = new RestateUsageGovernorClient(
      "http://127.0.0.1:8080/",
      observation.accountId,
      async (input) => {
        requestedUrl = String(input);
        return Response.json({
          action: "admit",
          reason: "headroom-available",
          weeklyUsedPercent: 40,
          dailyUsedPercent: 0,
          observedAt: observation.observedAt,
        });
      },
    );
    await client.observe({ observation, now: observation.observedAt });
    expect(requestedUrl).toContain("AccountGovernor/codex%2Fpro%201/observe");
  });

  it("rejects observations from another account", async () => {
    const client = new RestateUsageGovernorClient(
      "http://127.0.0.1:8080",
      "another-account",
    );
    await expect(
      client.observe({ observation, now: observation.observedAt }),
    ).rejects.toThrow("does not match");
  });
});
