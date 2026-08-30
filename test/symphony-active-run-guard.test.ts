import { describe, expect, it } from "vitest";
import {
  evaluateSymphonyActiveRunGuard,
  parseSymphonyActiveRunGuardRequest,
} from "../src/integrations/symphony/active-run-guard.js";
import type { SymphonyAdmissionEnvelope } from "../src/integrations/symphony/admission-envelope.js";
import type { HostObservationSnapshot } from "../src/gateway/host-observation-journal.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";
import {
  createExecutionAdmissionDigest,
  type ExecutionAdmissionBinding,
} from "../src/adapters/execution-admission.js";
import { authorityTask, claim, report, usage } from "./helpers.js";

const now = "2026-08-13T18:00:30.000Z";
const args = [
  "--schema-version",
  "1",
  "--issue-id",
  "1234",
  "--issue-identifier",
  "GH-1234",
  "--worker-host",
  "linux-control-1",
  "--thread-id",
  "thread-1234",
  "--turn-id",
  "turn-1234",
];

const request = parseSymphonyActiveRunGuardRequest(args);

function envelope(): SymphonyAdmissionEnvelope {
  const binding: ExecutionAdmissionBinding = {
    qualification: report(),
    authorityTask: authorityTask({
      state: "approved_for_pr",
      executionAuthority: "pr-only",
    }),
    claim: claim({
      claimId: "claim-1234-epoch-1",
      hostId: "linux-control-1",
      claimedAt: "2026-08-13T18:00:20.000Z",
    }),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
    target: "shared",
  };
  return {
    schemaVersion: 1,
    preparedAt: "2026-08-13T18:00:20.000Z",
    selectedHost: { id: "linux-control-1", lane: "linux" },
    usage: usage(),
    binding,
    admission: {
      schemaVersion: 1,
      bridgeId: "freed-authority-v1",
      authorityClaimId: binding.claim.claimId,
      taskId: binding.authorityTask.id,
      taskRevision: binding.authorityTask.revision,
      bindingDigest: createExecutionAdmissionDigest(binding),
      authorizedAt: "2026-08-13T18:00:20.000Z",
      expiresAt: "2026-08-13T18:05:20.000Z",
    },
  };
}

function observations(overrides: {
  readonly heartbeatAt?: string;
  readonly weeklyUsedPercent?: number;
  readonly dailyBaselinePercent?: number;
  readonly observedAt?: string;
} = {}): HostObservationSnapshot {
  const currentUsage = usage({
    observedAt: overrides.observedAt ?? "2026-08-13T18:00:20.000Z",
    primary: {
      usedPercent: overrides.weeklyUsedPercent ?? 40,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    dailyBaseline: {
      observedAt: "2026-08-13T07:00:00.000Z",
      usedPercent: overrides.dailyBaselinePercent ?? 35,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
  });
  return {
    schemaVersion: 1,
    revision: 2,
    observedAt: currentUsage.observedAt,
    hosts: [
      {
        id: "linux-control-1",
        lane: "linux",
        online: true,
        lastHeartbeatAt: overrides.heartbeatAt ?? "2026-08-13T18:00:20.000Z",
        activeClaims: [],
        accountIds: ["codex-pro-1"],
      },
    ],
    usageByAccountId: { "codex-pro-1": currentUsage },
  };
}

const enrollments: HostEnrollments = {
  "linux-control-1": {
    enabled: true,
    lane: "linux",
    accountIds: ["codex-pro-1"],
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  },
};

describe("Symphony active-run guard", () => {
  it("parses and binds the exact issue, host, thread, and turn", () => {
    expect(request).toMatchObject({
      issueId: "1234",
      issueIdentifier: "GH-1234",
      workerHost: "linux-control-1",
      threadId: "thread-1234",
      turnId: "turn-1234",
    });
    expect(() =>
      parseSymphonyActiveRunGuardRequest(
        args.map((value) => (value === "turn-1234" ? "bad turn" : value)),
      ),
    ).toThrow();
  });

  it("continues through headroom, throttling, and admission-stop bands", () => {
    for (const weeklyUsedPercent of [40, 50, 55]) {
      const result = evaluateSymphonyActiveRunGuard({
        request,
        envelope: envelope(),
        observations: observations({ weeklyUsedPercent }),
        enrollments,
        now,
      });
      expect(result.decision).toBe("continue");
    }
  });

  it("interrupts at the rolling-week ceiling and daily hard limit", () => {
    expect(
      evaluateSymphonyActiveRunGuard({
        request,
        envelope: envelope(),
        observations: observations({ weeklyUsedPercent: 80 }),
        enrollments,
        now,
      }),
    ).toMatchObject({ decision: "interrupt", reason: "quota-weekly-ceiling" });
    expect(
      evaluateSymphonyActiveRunGuard({
        request,
        envelope: envelope(),
        observations: observations({
          weeklyUsedPercent: 60,
          dailyBaselinePercent: 35,
        }),
        enrollments,
        now,
      }),
    ).toMatchObject({ decision: "interrupt", reason: "quota-daily-interrupt" });
  });

  it("fails closed for stale telemetry and changed host custody", () => {
    expect(
      evaluateSymphonyActiveRunGuard({
        request,
        envelope: envelope(),
        observations: observations({
          heartbeatAt: "2026-08-13T17:58:00.000Z",
        }),
        enrollments,
        now,
      }),
    ).toMatchObject({ decision: "interrupt", reason: "active-host-stale" });
    expect(
      evaluateSymphonyActiveRunGuard({
        request: { ...request, workerHost: "mac-worker-1" },
        envelope: envelope(),
        observations: observations(),
        enrollments,
        now,
      }),
    ).toMatchObject({ decision: "interrupt", reason: "active-binding-mismatch" });
  });

  it("fails closed when live account telemetry is missing", () => {
    expect(
      evaluateSymphonyActiveRunGuard({
        request,
        envelope: envelope(),
        observations: { ...observations(), usageByAccountId: {} },
        enrollments,
        now,
      }),
    ).toMatchObject({ decision: "interrupt", reason: "active-quota-missing" });
  });
});
