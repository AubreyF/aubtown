import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionAdmissionBinding } from "../src/adapters/execution-admission.js";
import {
  prepareSymphonyAdmissionCandidate,
  publishSymphonyAdmissionCandidateFile,
} from "../src/integrations/symphony/admission-candidate.js";
import {
  loadSymphonyAdmissionCandidate,
  type SymphonyAdmissionCandidate,
} from "../src/integrations/symphony/admission-envelope.js";
import { authorityTask, claim, report, usage } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-candidate-publisher-")),
  );
  roots.push(root);
  return root;
}

function candidate(
  overrides: {
    readonly selectedHostId?: string;
    readonly usedPercent?: number;
    readonly labels?: readonly string[];
  } = {},
): SymphonyAdmissionCandidate {
  const qualification = report();
  const binding: ExecutionAdmissionBinding = {
    qualification: {
      ...qualification,
      issue: {
        ...qualification.issue,
        labels: [...(overrides.labels ?? qualification.issue.labels)],
      },
    },
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
    preparedAt: "2026-08-13T18:00:30.000Z",
    selectedHost: {
      id: overrides.selectedHostId ?? "linux-control-1",
      lane: "linux",
    },
    usage: usage({
      observedAt: "2026-08-13T18:00:20.000Z",
      primary: {
        usedPercent: overrides.usedPercent ?? 40,
        windowDurationMinutes: 10_080,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
      dailyBaseline: {
        observedAt: "2026-08-13T07:00:00.000Z",
        usedPercent: 35,
        resetsAt: "2026-08-18T08:00:00.000Z",
      },
    }),
    binding,
  };
}

describe("Symphony admission candidate publisher", () => {
  it("publishes one protected candidate without creating authority", async () => {
    const root = await temporaryRoot();
    const inputFile = path.join(root, "candidate-input.json");
    const candidateRoot = path.join(root, "published");
    const prepared = candidate();
    await writeFile(inputFile, JSON.stringify(prepared), { mode: 0o600 });

    await expect(
      publishSymphonyAdmissionCandidateFile({ inputFile, candidateRoot }),
    ).resolves.toEqual({
      issueId: "1234",
      file: path.join(candidateRoot, "issue-1234.json"),
    });
    const published = await loadSymphonyAdmissionCandidate(
      candidateRoot,
      "1234",
    );
    expect(published).toEqual(prepared);
    expect(published).not.toHaveProperty("admission");
  });

  it("rejects blocked quota before creating a candidate", async () => {
    const blocked = candidate({ usedPercent: 80 });
    expect(() => prepareSymphonyAdmissionCandidate(blocked)).toThrow(
      "weekly-ceiling",
    );
  });

  it("rejects a selected host that does not own the intended claim", () => {
    expect(() =>
      prepareSymphonyAdmissionCandidate(
        candidate({ selectedHostId: "another-linux-host" }),
      ),
    ).toThrow("selected route");
  });

  it("rejects conflicting lifecycle labels even when eligible is asserted", () => {
    expect(() =>
      prepareSymphonyAdmissionCandidate(
        candidate({
          labels: ["debt", "factory:ready", "factory:running"],
        }),
      ),
    ).toThrow("issue-ineligible");
  });

  it("rejects a writable input file and leaves no published state", async () => {
    const root = await temporaryRoot();
    const inputFile = path.join(root, "candidate-input.json");
    const candidateRoot = path.join(root, "published");
    await writeFile(inputFile, JSON.stringify(candidate()), { mode: 0o600 });
    await chmod(inputFile, 0o666);
    await expect(
      publishSymphonyAdmissionCandidateFile({ inputFile, candidateRoot }),
    ).rejects.toThrow("protected physical file");
    await expect(
      readFile(path.join(candidateRoot, "issue-1234.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
