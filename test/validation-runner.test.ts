import { describe, expect, it } from "vitest";
import {
  ExactValidationRunner,
  type ValidationProcessRunner,
  type WorkProductStateInspector,
} from "../src/adjudication/validation-runner.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import { FREED_REPOSITORY } from "./helpers.js";

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
  head: "c".repeat(40),
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

describe("ExactValidationRunner", () => {
  it("binds no-shell argv and output digests to unchanged work", async () => {
    const inspector: WorkProductStateInspector = {
      inspect: async () => ({
        head: workProduct.head,
        patchDigest: workProduct.patchDigest,
      }),
    };
    const processes: ValidationProcessRunner = {
      run: async () => ({
        executable: "/opt/node/bin/npm",
        exitCode: 0,
        stdout: "pass\n",
        stderr: "",
        durationMs: 1_000,
      }),
    };
    const receipt = await new ExactValidationRunner(
      inspector,
      processes,
      () => new Date("2026-08-13T18:00:00.000Z"),
    ).run({
      workProduct,
      commands: [
        {
          executable: "/opt/node/bin/npm",
          args: ["test"],
          timeoutMs: 60_000,
        },
      ],
      env: { PATH: "/opt/node/bin:/usr/bin:/bin" },
    });
    expect(receipt).toMatchObject({
      passed: true,
      workProduct,
      commands: [
        {
          argv: ["/opt/node/bin/npm", "test"],
          cwd: workProduct.worktree,
          exitCode: 0,
          durationMs: 1_000,
        },
      ],
    });
    expect(receipt.commands[0]?.outputDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("stops after the first failing validation command", async () => {
    let runs = 0;
    const runner = new ExactValidationRunner(
      {
        inspect: async () => ({
          head: workProduct.head,
          patchDigest: workProduct.patchDigest,
        }),
      },
      {
        run: async () => {
          runs += 1;
          return {
            executable: "/opt/node/bin/npm",
            exitCode: 1,
            stdout: "",
            stderr: "failed\n",
            durationMs: 500,
          };
        },
      },
    );
    const receipt = await runner.run({
      workProduct,
      commands: [
        { executable: "/opt/node/bin/npm", args: ["test"], timeoutMs: 1_000 },
        { executable: "/opt/node/bin/npm", args: ["run", "build"], timeoutMs: 1_000 },
      ],
      env: {},
    });
    expect(runs).toBe(1);
    expect(receipt.passed).toBe(false);
    expect(receipt.commands).toHaveLength(1);
  });

  it("rejects a validation command that changes the worktree", async () => {
    let inspections = 0;
    await expect(
      new ExactValidationRunner(
        {
          inspect: async () => ({
            head: workProduct.head,
            patchDigest:
              inspections++ === 0 ? workProduct.patchDigest : "f".repeat(64),
          }),
        },
        {
          run: async () => ({
            executable: "/opt/node/bin/npm",
            exitCode: 0,
            stdout: "pass\n",
            stderr: "",
            durationMs: 500,
          }),
        },
      ).run({
        workProduct,
        commands: [
          { executable: "/opt/node/bin/npm", args: ["test"], timeoutMs: 1_000 },
        ],
        env: {},
      }),
    ).rejects.toThrow("no longer matches");
  });
});
