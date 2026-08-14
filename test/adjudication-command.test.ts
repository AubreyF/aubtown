import { describe, expect, it } from "vitest";
import {
  assertAdjudicationCommand,
  createAdjudicationCommand,
  sameAdjudicationCommand,
} from "../src/adjudication/command.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import { FREED_REPOSITORY, report, usage } from "./helpers.js";

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  branch: "fix/deterministic-validation",
  worktree: "/worktrees/1234",
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead: "a".repeat(40),
  head: "b".repeat(40),
  patchDigest: "c".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

describe("adjudication command", () => {
  it("binds reviewed no-shell validation commands to one work product", () => {
    const command = createAdjudicationCommand({
      commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
      workProduct,
      qualification: report(),
      accountId: "codex-pro-1",
      usageAtAdmission: usage(),
      reviewerDriverId: "codex-app-server-review-v1",
      validationCommands: [
        {
          executable: "/opt/node/bin/npm",
          args: ["test"],
          timeoutMs: 60_000,
        },
      ],
      issuedAt: "2026-08-13T18:00:00.000Z",
    });

    expect(assertAdjudicationCommand(command, workProduct.hostId)).toEqual(command);
    expect(sameAdjudicationCommand(command, structuredClone(command))).toBe(true);
    expect(() => assertAdjudicationCommand(command, "macos-executor-1")).toThrow(
      "another host",
    );
  });

  it("rejects issue-derived shell executables and mismatched qualification", () => {
    expect(() =>
      createAdjudicationCommand({
        commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
        workProduct,
        qualification: report(),
        accountId: "codex-pro-1",
        usageAtAdmission: usage(),
        reviewerDriverId: "codex-app-server-review-v1",
        validationCommands: [
          { executable: "sh", args: ["-c", "npm test"], timeoutMs: 60_000 },
        ],
        issuedAt: "2026-08-13T18:00:00.000Z",
      }),
    ).toThrow();
    const qualification = report();
    expect(() =>
      createAdjudicationCommand({
        commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
        workProduct,
        qualification: {
          ...qualification,
          issue: { ...qualification.issue, number: 9_999 },
        },
        accountId: "codex-pro-1",
        usageAtAdmission: usage(),
        reviewerDriverId: "codex-app-server-review-v1",
        validationCommands: [
          { executable: "/opt/node/bin/npm", args: ["test"], timeoutMs: 60_000 },
        ],
        issuedAt: "2026-08-13T18:00:00.000Z",
      }),
    ).toThrow();
  });
});
