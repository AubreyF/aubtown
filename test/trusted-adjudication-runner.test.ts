import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdjudicationCommand } from "../src/adjudication/command.js";
import {
  HostAdjudicationJournal,
  type HostReviewHandle,
} from "../src/adjudication/journal.js";
import type {
  ExactValidationReceipt,
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import {
  TrustedAdjudicationResultStore,
  TrustedAdjudicationRunner,
} from "../src/adjudication/trusted-runner.js";
import type { RawAccountUsageObservation } from "../src/domain/types.js";
import { FREED_REPOSITORY, report, usage } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

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

const command = createAdjudicationCommand({
  commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
  workProduct,
  qualification: report(),
  accountId: "codex-pro-1",
  usageAtAdmission: usage({ observedAt: "2026-08-13T18:00:00.000Z" }),
  reviewerDriverId: "codex-app-server-review-v1",
  validationCommands: [
    { executable: "/usr/bin/true", args: [], timeoutMs: 60_000 },
  ],
  issuedAt: "2026-08-13T18:00:00.000Z",
});

function validation(passed = true): ExactValidationReceipt {
  return {
    schemaVersion: 1,
    kind: "exact-validation",
    workProduct,
    passed,
    commands: [
      {
        argv: ["/usr/bin/true"],
        cwd: workProduct.worktree,
        exitCode: passed ? 0 : 1,
        outputDigest: "e".repeat(64),
        durationMs: 10,
      },
    ],
    completedAt: "2026-08-13T18:00:01.000Z",
    summary: passed ? "Validation passed." : "Validation failed.",
  };
}

const handle: HostReviewHandle = {
  driverId: "codex-app-server-review-v1",
  threadId: "review-thread",
  turnId: "review-turn",
  startedAt: "2026-08-13T18:00:02.000Z",
  workProduct,
};

function review(verdict: "pass" | "changes-requested" = "pass"): IndependentReviewReceipt {
  return {
    schemaVersion: 1,
    kind: "independent-review",
    workProduct,
    reviewer: {
      driverId: handle.driverId,
      threadId: handle.threadId,
      turnId: handle.turnId,
    },
    verdict,
    findings:
      verdict === "pass"
        ? []
        : [
            {
              severity: "high",
              title: "Regression",
              body: "The candidate changes the wrong behavior.",
            },
          ],
    completedAt: "2026-08-13T18:00:03.000Z",
    summary: verdict === "pass" ? "Review passed." : "Changes requested.",
  };
}

function observation(
  usedPercent = 40,
  observedAt = "2026-08-13T18:00:02.000Z",
): RawAccountUsageObservation {
  return {
    accountId: "codex-pro-1",
    observedAt,
    primary: {
      usedPercent,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-08-18T08:00:00.000Z",
    },
    lifetimeTokens: 1_050_000,
    activeTurnIds: [],
  };
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(
      path.join(await realpath(os.tmpdir()), "aubtown-trusted-review-"),
    ),
  );
  roots.push(root);
  return {
    root,
    journal: new HostAdjudicationJournal(path.join(root, "journal.json")),
    results: new TrustedAdjudicationResultStore(path.join(root, "results")),
  };
}

describe("TrustedAdjudicationRunner", () => {
  it("runs exact validation and a fresh independent review once", async () => {
    const state = await fixture();
    let validationRuns = 0;
    let starts = 0;
    let waits = 0;
    const runner = new TrustedAdjudicationRunner(
      {
        run: async () => {
          validationRuns += 1;
          return validation();
        },
      },
      {
        id: "codex-app-server-review-v1",
        start: async () => {
          starts += 1;
          return handle;
        },
        wait: async () => {
          waits += 1;
          return review();
        },
      },
      { id: "usage", read: async () => observation() },
      { interrupt: async () => undefined },
      state.journal,
      state.results,
      { PATH: "/usr/bin:/bin" },
      () => new Date("2026-08-13T18:00:04.000Z"),
      5,
    );

    await expect(runner.run(command)).resolves.toMatchObject({
      outcome: "ready",
      validation: { passed: true },
      review: { verdict: "pass" },
    });
    await expect(runner.run(command)).resolves.toMatchObject({ outcome: "ready" });
    expect({ validationRuns, starts, waits }).toEqual({
      validationRuns: 1,
      starts: 1,
      waits: 1,
    });
  });

  it("blocks a failed validation without spending a review turn", async () => {
    const state = await fixture();
    let starts = 0;
    const result = await new TrustedAdjudicationRunner(
      { run: async () => validation(false) },
      {
        id: "codex-app-server-review-v1",
        start: async () => {
          starts += 1;
          return handle;
        },
        wait: async () => review(),
      },
      { id: "usage", read: async () => observation() },
      { interrupt: async () => undefined },
      state.journal,
      state.results,
      {},
    ).run(command);

    expect(result.outcome).toBe("blocked");
    expect(result).not.toHaveProperty("review");
    expect(starts).toBe(0);
  });

  it("refuses to start review when fresh weekly quota has no headroom", async () => {
    const state = await fixture();
    let starts = 0;
    await expect(
      new TrustedAdjudicationRunner(
        { run: async () => validation() },
        {
          id: "codex-app-server-review-v1",
          start: async () => {
            starts += 1;
            return handle;
          },
          wait: async () => review(),
        },
        { id: "usage", read: async () => observation(80) },
        { interrupt: async () => undefined },
        state.journal,
        state.results,
        {},
      ).run(command),
    ).rejects.toThrow("weekly-ceiling");
    expect(starts).toBe(0);
  });

  it("interrupts a running review when the weekly ceiling is reached", async () => {
    const state = await fixture();
    let reads = 0;
    let interrupts = 0;
    await expect(
      new TrustedAdjudicationRunner(
        { run: async () => validation() },
        {
          id: "codex-app-server-review-v1",
          start: async () => handle,
          wait: async () => await new Promise<IndependentReviewReceipt>(() => undefined),
        },
        {
          id: "usage",
          read: async () => {
            reads += 1;
            return reads === 1 ? observation(40) : observation(80, "2026-08-13T18:00:03.000Z");
          },
        },
        {
          interrupt: async () => {
            interrupts += 1;
          },
        },
        state.journal,
        state.results,
        {},
        () => new Date("2026-08-13T18:00:04.000Z"),
        1,
      ).run(command),
    ).rejects.toThrow("weekly-ceiling");
    expect(interrupts).toBe(1);
  });

  it("resumes a durable review handle after restart without starting another", async () => {
    const state = await fixture();
    await state.journal.accept(command, "validate", "2026-08-13T18:00:00.000Z");
    await state.journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "validated",
      validation: validation(),
    }));
    await state.journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "review-started",
      reviewHandle: handle,
    }));
    let starts = 0;
    let recoveries = 0;
    const result = await new TrustedAdjudicationRunner(
      { run: async () => { throw new Error("must not validate"); } },
      {
        id: "codex-app-server-review-v1",
        start: async () => {
          starts += 1;
          return handle;
        },
        wait: async (current) => {
          expect(current).toEqual(handle);
          return review();
        },
        recover: async (current) => {
          expect(current).toEqual(handle);
          recoveries += 1;
          return "completed";
        },
      },
      { id: "usage", read: async () => observation() },
      { interrupt: async () => undefined },
      state.journal,
      state.results,
      {},
    ).run(command);

    expect(result.outcome).toBe("ready");
    expect(starts).toBe(0);
    expect(recoveries).toBe(1);
  });

  it("fails closed at an ambiguous reviewer start boundary", async () => {
    const state = await fixture();
    await state.journal.accept(command, "validate", "2026-08-13T18:00:00.000Z");
    await state.journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "validated",
      validation: validation(),
    }));
    await state.journal.transition(command.commandId, (current) => ({
      ...current,
      stage: "review-starting",
    }));
    await expect(
      new TrustedAdjudicationRunner(
        { run: async () => { throw new Error("must not validate"); } },
        {
          id: "codex-app-server-review-v1",
          start: async () => { throw new Error("must not start"); },
          wait: async () => review(),
        },
        { id: "usage", read: async () => observation() },
        { interrupt: async () => undefined },
        state.journal,
        state.results,
        {},
      ).run(command),
    ).rejects.toThrow("ambiguous");
  });
});
