import {
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionAdmissionDigest,
  type ExecutionAdmissionBinding,
} from "../src/adapters/execution-admission.js";
import type { HostRecord } from "../src/domain/types.js";
import {
  authorizeSymphonyPrelaunch,
  loadSymphonyAdmissionEnvelope,
  resolveSymphonyAdmissionEnvelopePath,
  SymphonyPrelaunchReceiptStore,
  type SymphonyAdmissionEnvelope,
} from "../src/integrations/symphony/admission-envelope.js";
import { parseSymphonyPrelaunchRequest } from "../src/integrations/symphony/prelaunch.js";
import { planExecutionRouteFromState } from "../src/orchestration/route-planner.js";
import { authorityTask, claim, report, usage } from "./helpers.js";

const roots: string[] = [];
const now = "2026-08-13T18:00:30.000Z";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

function request(workerHost = "linux-control-1") {
  return parseSymphonyPrelaunchRequest([
    "--schema-version",
    "1",
    "--issue-id",
    "1234",
    "--issue-identifier",
    "GH-1234",
    "--worker-host",
    workerHost,
  ]);
}

function envelope(
  overrides: {
    readonly claimId?: string;
    readonly hostId?: string;
    readonly hostLane?: "linux" | "macos";
    readonly usagePercent?: number;
    readonly dailyBaselinePercent?: number;
  } = {},
): SymphonyAdmissionEnvelope {
  const hostId = overrides.hostId ?? "linux-control-1";
  const binding: ExecutionAdmissionBinding = {
    qualification: report(),
    authorityTask: authorityTask({
      state: "approved_for_pr",
      executionAuthority: "pr-only",
    }),
    claim: claim({
      claimId: overrides.claimId ?? "claim-1234-epoch-1",
      hostId,
    }),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
    target: "shared",
  };
  return {
    schemaVersion: 1,
    preparedAt: "2026-08-13T18:00:20.000Z",
    selectedHost: {
      id: hostId,
      lane: overrides.hostLane ?? "linux",
    },
    usage: usage({
      observedAt: "2026-08-13T18:00:20.000Z",
      primary: {
        usedPercent: overrides.usagePercent ?? 40,
        windowDurationMinutes: 10_080,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
      dailyBaseline: {
        observedAt: "2026-08-13T07:00:00.000Z",
        usedPercent: overrides.dailyBaselinePercent ?? 35,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
    }),
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

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

describe("Symphony final admission envelope", () => {
  it("admits one exact claim and blocks it after a coordinator restart", async () => {
    const root = await temporaryRoot("aubtown-prelaunch-");
    const receiptRoot = path.join(root, "receipts");
    const first = await authorizeSymphonyPrelaunch({
      request: request(),
      envelope: envelope(),
      receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
      now,
    });
    expect(first).toMatchObject({ decision: "admit" });

    const afterRestart = await authorizeSymphonyPrelaunch({
      request: request(),
      envelope: envelope(),
      receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
      now,
    });
    expect(afterRestart).toMatchObject({
      decision: "deny",
      reason: "dispatch-already-admitted",
    });
    expect(await readdir(receiptRoot)).toHaveLength(1);
  });

  it("serializes simultaneous prelaunch attempts with exclusive receipt creation", async () => {
    const root = await temporaryRoot("aubtown-prelaunch-race-");
    const receiptRoot = path.join(root, "receipts");
    const results = await Promise.all([
      authorizeSymphonyPrelaunch({
        request: request(),
        envelope: envelope(),
        receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
        now,
      }),
      authorizeSymphonyPrelaunch({
        request: request(),
        envelope: envelope(),
        receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
        now,
      }),
    ]);
    expect(results.filter((result) => result.decision === "admit")).toHaveLength(1);
    expect(results.filter((result) => result.decision === "deny")).toEqual([
      expect.objectContaining({ reason: "dispatch-already-admitted" }),
    ]);
  });

  it("allows a new authority claim after reconciliation without deleting history", async () => {
    const root = await temporaryRoot("aubtown-prelaunch-reconciled-");
    const receiptRoot = path.join(root, "receipts");
    await expect(
      authorizeSymphonyPrelaunch({
        request: request(),
        envelope: envelope({ claimId: "claim-1234-epoch-1" }),
        receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
        now,
      }),
    ).resolves.toMatchObject({ decision: "admit" });
    await expect(
      authorizeSymphonyPrelaunch({
        request: request(),
        envelope: envelope({ claimId: "claim-1234-epoch-2" }),
        receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
        now,
      }),
    ).resolves.toMatchObject({ decision: "admit" });
    expect(await readdir(receiptRoot)).toHaveLength(2);
  });

  it.each([
    [80, 35, "quota-weekly-ceiling"],
    [44, 35, "quota-daily-admission-stop"],
    [45, 35, "quota-daily-interrupt"],
  ] as const)(
    "blocks quota state %s before writing a launch receipt",
    async (usagePercent, dailyBaselinePercent, reason) => {
      const root = await temporaryRoot("aubtown-prelaunch-quota-");
      const receiptRoot = path.join(root, "receipts");
      const result = await authorizeSymphonyPrelaunch({
        request: request(),
        envelope: envelope({ usagePercent, dailyBaselinePercent }),
        receiptStore: new SymphonyPrelaunchReceiptStore(receiptRoot),
        now,
      });
      expect(result).toMatchObject({ decision: "deny", reason });
      await expect(readdir(receiptRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("routes portable work through Linux and admits it while the Mac is offline", async () => {
    const hosts: readonly HostRecord[] = [
      {
        id: "linux-control-1",
        lane: "linux",
        online: true,
        lastHeartbeatAt: "2026-08-13T18:00:20.000Z",
        activeClaims: [],
        accountIds: ["codex-pro-1"],
      },
      {
        id: "macos-executor-1",
        lane: "macos",
        online: false,
        lastHeartbeatAt: "2026-08-13T17:00:00.000Z",
        activeClaims: [],
        accountIds: ["codex-pro-mac"],
      },
    ];
    const route = planExecutionRouteFromState({
      requiredLane: "linux",
      hosts,
      profiles: {
        "codex-pro-1": {
          driverId: "codex-app-server-v1",
          enabled: true,
          hostIds: ["linux-control-1"],
        },
        "codex-pro-mac": {
          driverId: "codex-app-server-v1",
          enabled: true,
          hostIds: ["macos-executor-1"],
        },
      },
      usageByAccountId: {
        "codex-pro-1": envelope().usage,
        "codex-pro-mac": null,
      },
      now,
    });
    expect(route).toMatchObject({
      reason: "selected",
      route: { hostId: "linux-control-1" },
    });
    if (route.route === undefined) {
      throw new Error("Portable work did not select the Linux route.");
    }

    const root = await temporaryRoot("aubtown-prelaunch-linux-");
    await expect(
      authorizeSymphonyPrelaunch({
        request: request(route.route.hostId),
        envelope: envelope({ hostId: route.route.hostId }),
        receiptStore: new SymphonyPrelaunchReceiptStore(
          path.join(root, "receipts"),
        ),
        now,
      }),
    ).resolves.toMatchObject({ decision: "admit" });
  });

  it("loads only a protected physical envelope file", async () => {
    const root = await temporaryRoot("aubtown-envelope-");
    const file = resolveSymphonyAdmissionEnvelopePath(root, "1234");
    await writeFile(file, `${JSON.stringify(envelope())}\n`, { mode: 0o600 });
    await expect(loadSymphonyAdmissionEnvelope(root, "1234")).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await chmod(file, 0o666);
    await expect(loadSymphonyAdmissionEnvelope(root, "1234")).rejects.toThrow(
      "protected physical file",
    );
  });
});
