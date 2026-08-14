import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AccountUsageSnapshot,
  HostRecord,
} from "../src/domain/types.js";
import { assembleReconciledAdmissionCandidate } from "../src/orchestration/admission-candidate-reconciler.js";
import { publishReconciledAdmissionCandidateFile } from "../src/integrations/symphony/reconciled-candidate.js";
import { loadSymphonyAdmissionCandidate } from "../src/integrations/symphony/admission-envelope.js";
import { canonicalJson } from "../src/security/canonical-json.js";
import { authorityTask, claim, report, usage } from "./helpers.js";

const now = "2026-08-13T18:00:30.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-reconciler-")),
  );
  roots.push(root);
  return root;
}
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
    online: true,
    lastHeartbeatAt: "2026-08-13T18:00:20.000Z",
    activeClaims: [],
    accountIds: ["codex-pro-2"],
  },
];
const profiles = {
  "codex-pro-1": {
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: ["linux-control-1"],
  },
  "codex-pro-2": {
    driverId: "codex-app-server-v1",
    enabled: true,
    hostIds: ["macos-executor-1"],
  },
};

function quota(
  accountId: string,
  usedPercent: number,
): AccountUsageSnapshot {
  return usage({
    accountId,
    observedAt: "2026-08-13T18:00:20.000Z",
    primary: {
      usedPercent,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    dailyBaseline: {
      observedAt: "2026-08-13T07:00:00.000Z",
      usedPercent: Math.max(0, usedPercent - 2),
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
  });
}

function input(overrides: {
  readonly intendedHostId?: string;
  readonly activeClaims?: readonly ReturnType<typeof claim>[];
  readonly activeLanes?: readonly "runtime-neutral"[];
  readonly usageByAccountId?: Readonly<
    Record<string, AccountUsageSnapshot | null>
  >;
  readonly hosts?: readonly HostRecord[];
} = {}) {
  return {
    qualification: report(),
    authorityTask: authorityTask({
      state: "approved_for_pr",
      executionAuthority: "pr-only",
    }),
    intendedClaim: claim({
      claimId: "claim-1234-epoch-1",
      hostId: overrides.intendedHostId ?? "linux-control-1",
      claimedAt: "2026-08-13T18:00:20.000Z",
    }),
    hosts: overrides.hosts ?? hosts,
    accountProfiles: profiles,
    usageByAccountId: overrides.usageByAccountId ?? {
      "codex-pro-1": quota("codex-pro-1", 20),
      "codex-pro-2": quota("codex-pro-2", 40),
    },
    activeClaims: overrides.activeClaims ?? [],
    activeLanes: overrides.activeLanes ?? [],
    baseHead: "a".repeat(40),
    target: "shared" as const,
    now,
  };
}

describe("reconciled admission candidate assembly", () => {
  it("assembles the exact lowest-usage compatible route", () => {
    expect(assembleReconciledAdmissionCandidate(input())).toMatchObject({
      schemaVersion: 1,
      preparedAt: now,
      selectedHost: { id: "linux-control-1", lane: "linux" },
      usage: { accountId: "codex-pro-1" },
      binding: {
        accountId: "codex-pro-1",
        driverId: "codex-app-server-v1",
        claim: { claimId: "claim-1234-epoch-1" },
      },
    });
  });

  it("is byte-stable for the same reconciled snapshot", () => {
    const snapshot = input();
    expect(
      Buffer.from(canonicalJson(assembleReconciledAdmissionCandidate(snapshot))),
    ).toEqual(
      Buffer.from(canonicalJson(assembleReconciledAdmissionCandidate(snapshot))),
    );
  });

  it("rejects a claim routed to a host other than the selected host", () => {
    expect(() =>
      assembleReconciledAdmissionCandidate(
        input({ intendedHostId: "macos-executor-1" }),
      ),
    ).toThrow("does not match the selected route");
  });

  it("blocks a second pilot claim before producing candidate state", () => {
    expect(() =>
      assembleReconciledAdmissionCandidate(
        input({
          activeClaims: [claim({ claimId: "another-claim" })],
          activeLanes: ["runtime-neutral"],
        }),
      ),
    ).toThrow("global-cap");
  });

  it("fails closed when compatible subscription telemetry is absent", () => {
    expect(() =>
      assembleReconciledAdmissionCandidate(
        input({
          usageByAccountId: {
            "codex-pro-1": null,
            "codex-pro-2": null,
          },
        }),
      ),
    ).toThrow("telemetry-unavailable");
  });

  it("rejects snapshots whose active claim and lane sets disagree", () => {
    expect(() =>
      assembleReconciledAdmissionCandidate(
        input({
          activeClaims: [claim({ claimId: "another-claim" })],
          activeLanes: [],
        }),
      ),
    ).toThrow("not one-to-one");
  });

  it("does not route work to a host with a stale heartbeat", () => {
    const staleHosts = hosts.map((host) =>
      host.id === "linux-control-1"
        ? { ...host, lastHeartbeatAt: "2026-08-13T17:58:29.999Z" }
        : host,
    );
    expect(() =>
      assembleReconciledAdmissionCandidate(
        input({ hosts: staleHosts }),
      ),
    ).toThrow("macos-executor-1");
  });

  it("publishes a reconciled protected snapshot through the native boundary", async () => {
    const root = await temporaryRoot();
    const snapshotFile = path.join(root, "snapshot.json");
    const candidateRoot = path.join(root, "candidates");
    await writeFile(snapshotFile, JSON.stringify(input()), { mode: 0o600 });
    await expect(
      publishReconciledAdmissionCandidateFile({
        snapshotFile,
        candidateRoot,
      }),
    ).resolves.toEqual({
      issueId: "1234",
      file: path.join(candidateRoot, "issue-1234.json"),
    });
    await expect(
      loadSymphonyAdmissionCandidate(candidateRoot, "1234"),
    ).resolves.toMatchObject({
      selectedHost: { id: "linux-control-1" },
      binding: { accountId: "codex-pro-1" },
    });
  });

  it("rejects a writable reconciler snapshot before assembly", async () => {
    const root = await temporaryRoot();
    const snapshotFile = path.join(root, "snapshot.json");
    await writeFile(snapshotFile, JSON.stringify(input()), { mode: 0o600 });
    await chmod(snapshotFile, 0o666);
    await expect(
      publishReconciledAdmissionCandidateFile({
        snapshotFile,
        candidateRoot: path.join(root, "candidates"),
      }),
    ).rejects.toThrow("protected physical file");
  });
});
