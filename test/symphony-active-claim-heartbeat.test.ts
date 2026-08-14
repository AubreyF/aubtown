import { describe, expect, it } from "vitest";
import { heartbeatSymphonyActiveClaim } from "../src/integrations/symphony/active-claim-heartbeat.js";
import { createExecutionAdmissionDigest } from "../src/adapters/execution-admission.js";
import type { SymphonyAdmissionEnvelope } from "../src/integrations/symphony/admission-envelope.js";
import { authorityTask, claim, report, usage } from "./helpers.js";

function envelope(): SymphonyAdmissionEnvelope {
  const binding = {
    qualification: report(),
    authorityTask: authorityTask({
      state: "approved_for_pr",
      executionAuthority: "pr-only",
    }),
    claim: claim({
      claimId: "claim-1234-epoch-2",
      custodyEpoch: 2,
      claimedAt: "2026-08-13T18:00:00.000Z",
    }),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
    target: "shared" as const,
  };
  return {
    schemaVersion: 1,
    preparedAt: "2026-08-13T18:00:00.000Z",
    selectedHost: { id: binding.claim.hostId, lane: "linux" },
    usage: usage(),
    binding,
    admission: {
      schemaVersion: 1,
      bridgeId: "freed-authority-v1",
      authorityClaimId: binding.claim.claimId,
      taskId: binding.authorityTask.id,
      taskRevision: binding.authorityTask.revision,
      bindingDigest: createExecutionAdmissionDigest(binding),
      authorizedAt: "2026-08-13T18:00:00.000Z",
      expiresAt: "2026-08-13T18:05:00.000Z",
    },
  };
}

describe("Symphony active claim heartbeat", () => {
  it("heartbeats the exact admitted task, claim, and custody epoch", async () => {
    const requests: unknown[] = [];
    const result = await heartbeatSymphonyActiveClaim({
      envelope: envelope(),
      now: "2026-08-13T18:00:30.000Z",
      operationId: "f5c16430-39d0-4f93-aace-e54d8d1c443f",
      broker: {
        async heartbeat(request) {
          requests.push(request);
          return request;
        },
      },
    });
    expect(result).toMatchObject({
      taskId: "github-issue-1234",
      authorityClaimId: "claim-1234-epoch-2",
      custodyEpoch: 2,
      heartbeatAt: "2026-08-13T18:00:30.000Z",
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects a broker receipt for another custody epoch", async () => {
    await expect(
      heartbeatSymphonyActiveClaim({
        envelope: envelope(),
        now: "2026-08-13T18:00:30.000Z",
        operationId: "f5c16430-39d0-4f93-aace-e54d8d1c443f",
        broker: {
          async heartbeat(request) {
            return { ...request, custodyEpoch: request.custodyEpoch + 1 };
          },
        },
      }),
    ).rejects.toThrow("changed the exact claim");
  });
});
