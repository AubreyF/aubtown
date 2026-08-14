import { describe, expect, it } from "vitest";
import type {
  FreedClaimListReceipt,
  FreedClaimReleaseReceipt,
  FreedClaimReleaseRequest,
} from "../src/adapters/freed/claim-broker.js";
import {
  reconcileStaleFreedClaims,
  type StaleClaimBroker,
} from "../src/orchestration/stale-claim-reconciler.js";

const now = "2026-08-13T18:10:00.000Z";

function listedClaim(overrides: {
  readonly claimedAt?: string;
  readonly heartbeatAt?: string;
  readonly executionStage?: "claimed" | "running";
} = {}): FreedClaimListReceipt["claims"][number] {
  return {
    taskId: "github-issue-1234",
    taskRevision: 7,
    bindingDigest: "a".repeat(64),
    claim: {
      claimId: "claim-1234-epoch-1",
      githubIssue: {
        number: 1_234,
        url: "https://github.com/freed-project/freed/issues/1234",
      },
      custodyEpoch: 1,
      hostId: "linux-control-1",
      workerId: "worker-linux-control-1",
      branch: "fix/issue-1234",
      worktree: "/srv/worktrees/freed-issue-1234",
      conflictDomains: ["logical:tooling"],
      conflictDomainDigest: "b".repeat(64),
      claimedAt: overrides.claimedAt ?? "2026-08-13T18:00:00.000Z",
      heartbeatAt: overrides.heartbeatAt ?? "2026-08-13T18:07:00.000Z",
      baseHead: "c".repeat(40),
      accountId: "codex-pro-1",
      driverId: "codex-app-server-v1",
      target: "shared",
      workLane: "runtime-neutral",
      publicationCeiling: "draft-pr",
      executionStage: overrides.executionStage ?? "claimed",
    },
  };
}

class FakeBroker implements StaleClaimBroker {
  readonly releases: FreedClaimReleaseRequest[] = [];

  constructor(
    private claims: FreedClaimListReceipt["claims"],
    private readonly raceHeartbeat = false,
  ) {}

  async list(): Promise<FreedClaimListReceipt> {
    return { schemaVersion: 1, claims: this.claims };
  }

  async release(
    request: FreedClaimReleaseRequest,
  ): Promise<FreedClaimReleaseReceipt> {
    const current = this.claims.find(
      (entry) => entry.claim.claimId === request.authorityClaimId,
    );
    if (current === undefined) {
      throw new Error("claim missing");
    }
    if (
      this.raceHeartbeat ||
      current.claim.heartbeatAt !== request.expectedHeartbeatAt
    ) {
      throw new Error("claim heartbeat changed");
    }
    this.releases.push(request);
    this.claims = this.claims.filter(
      (entry) => entry.claim.claimId !== request.authorityClaimId,
    );
    return {
      schemaVersion: 1,
      operationId: request.operationId,
      taskId: request.taskId,
      taskRevision: request.expectedTaskRevision,
      authorityClaimId: request.authorityClaimId,
      bindingDigest: request.bindingDigest,
      custodyEpoch: request.custodyEpoch,
      expectedHeartbeatAt: request.expectedHeartbeatAt,
      reason: request.reason,
      releasedAt: request.releasedAt,
    };
  }
}

describe("stale Freed claim reconciliation", () => {
  it("releases an old claim after its active heartbeat stops", async () => {
    const broker = new FakeBroker([listedClaim()]);
    const result = await reconcileStaleFreedClaims({
      broker,
      now,
      operationId: () => "b57207bb-dd63-40ca-b91e-92dfa4cf4d71",
    });
    expect(result).toEqual({
      schemaVersion: 1,
      reconciledAt: now,
      status: "clear",
      releasedClaimIds: ["claim-1234-epoch-1"],
      freshClaimIds: [],
      graceClaimIds: [],
      strandedRunningClaimIds: [],
      remainingClaimIds: [],
    });
    expect(broker.releases).toEqual([
      expect.objectContaining({
        expectedHeartbeatAt: "2026-08-13T18:07:00.000Z",
        reason: "reconciled-unlaunched",
      }),
    ]);
  });

  it("keeps stale running custody fenced for restart or checkpoint transfer", async () => {
    const broker = new FakeBroker([
      listedClaim({ executionStage: "running" }),
    ]);
    await expect(reconcileStaleFreedClaims({ broker, now })).resolves.toMatchObject({
      status: "waiting",
      strandedRunningClaimIds: ["claim-1234-epoch-1"],
      releasedClaimIds: [],
    });
    expect(broker.releases).toEqual([]);
  });

  it("retains a claim with a current active-run heartbeat", async () => {
    const broker = new FakeBroker([
      listedClaim({ heartbeatAt: "2026-08-13T18:09:00.000Z" }),
    ]);
    await expect(reconcileStaleFreedClaims({ broker, now })).resolves.toMatchObject({
      status: "waiting",
      freshClaimIds: ["claim-1234-epoch-1"],
      releasedClaimIds: [],
    });
    expect(broker.releases).toEqual([]);
  });

  it("waits through the initial launch grace even without a heartbeat", async () => {
    const broker = new FakeBroker([
      listedClaim({
        claimedAt: "2026-08-13T18:06:00.000Z",
        heartbeatAt: "2026-08-13T18:06:00.000Z",
      }),
    ]);
    await expect(reconcileStaleFreedClaims({ broker, now })).resolves.toMatchObject({
      status: "waiting",
      graceClaimIds: ["claim-1234-epoch-1"],
      releasedClaimIds: [],
    });
  });

  it("fails closed when a heartbeat races the release", async () => {
    const broker = new FakeBroker([listedClaim()], true);
    await expect(reconcileStaleFreedClaims({ broker, now })).rejects.toThrow(
      "claim heartbeat changed",
    );
  });

  it("rejects impossible claim chronology", async () => {
    const broker = new FakeBroker([
      listedClaim({
        claimedAt: "2026-08-13T18:08:00.000Z",
        heartbeatAt: "2026-08-13T18:07:00.000Z",
      }),
    ]);
    await expect(reconcileStaleFreedClaims({ broker, now })).rejects.toThrow(
      "chronology is invalid",
    );
  });
});
