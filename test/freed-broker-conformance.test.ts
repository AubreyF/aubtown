import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import {
  parseFreedBrokerConformanceInput,
  runFreedBrokerConformance,
  type FreedBrokerConformanceInput,
} from "../src/adapters/freed/broker-conformance.js";

const disposableRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    disposableRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fixturePath(): string {
  return path.resolve("test/fixtures/freed-claim-broker.mjs");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function disposableBroker(root: string): Promise<string> {
  const executable = path.join(root, "factory-coordinator");
  const stateFile = path.join(root, "broker-state.json");
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath())} --state-file ${shellQuote(stateFile)} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

function config(executable: string): FreedBrokerConformanceInput {
  return {
    schemaVersion: 1,
    broker: {
      executable,
      cwd: process.cwd(),
      profile: "conformance-freed-pilot",
    },
    acquire: {
      schemaVersion: 1,
      taskId: "github-issue-1465",
      expectedTaskRevision: 7,
      bindingDigest: "a".repeat(64),
      claim: {
        claimId: "claim-1465-epoch-1",
        githubIssue: {
          number: 1_465,
          url: "https://github.com/freed-project/freed/issues/1465",
        },
        custodyEpoch: 1,
        hostId: "linux-coordinator",
        workerId: "worker-linux-coordinator",
        branch: "fix/factory-execution-claims",
        worktree: "/srv/aubtown/worktrees/freed-issue-1465",
        conflictDomains: ["scripts/automation-control.mjs", "authority"],
        conflictDomainDigest: "b".repeat(64),
        baseHead: "c".repeat(40),
        accountId: "codex-pro-1",
        driverId: "codex-app-server-v1",
        target: "shared",
        workLane: "runtime-neutral",
        publicationCeiling: "draft-pr",
      },
    },
    transfer: {
      destinationHostId: "mac-executor",
      destinationWorkerId: "worker-mac-executor",
      destinationWorktree: "/Users/aubrey/worktrees/freed-issue-1465",
      checkpointReference: "d".repeat(64),
    },
    release: {
      reason: "worker-completed",
    },
  };
}

describe("Freed broker conformance", () => {
  it("proves exact replay, duplicate rejection, restart, transfer fencing, and release", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "aubtown-broker-conformance-")),
    );
    disposableRoots.push(root);
    const executable = await disposableBroker(root);
    const report = await runFreedBrokerConformance({
      runner: new ProcessCommandRunner(),
      config: config(executable),
      checkedAt: "2026-08-13T20:04:00.000Z",
    });

    expect(report.passed, JSON.stringify(report)).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual([
      "broker-integrity",
      "acquire",
      "acquire-replay",
      "changed-operation-replay",
      "show-after-acquire",
      "list-after-acquire",
      "duplicate-acquire",
      "heartbeat-replay",
      "changed-heartbeat-replay",
      "transfer-replay",
      "stale-epoch-fenced",
      "show-after-transfer",
      "list-after-transfer",
      "release-replay",
      "show-after-release",
      "list-after-release",
    ]);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  }, 15_000);

  it("refuses a production-looking broker profile", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "aubtown-broker-conformance-")),
    );
    disposableRoots.push(root);
    const candidate = config(await disposableBroker(root));

    expect(() =>
      parseFreedBrokerConformanceInput({
        ...candidate,
        broker: { ...candidate.broker, profile: "freed-production" },
      }),
    ).toThrow();
  });

  it("fails closed when the reviewed broker executable is absent", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "aubtown-broker-conformance-")),
    );
    disposableRoots.push(root);
    const candidate = config(await disposableBroker(root));
    const report = await runFreedBrokerConformance({
      runner: new ProcessCommandRunner(),
      config: {
        ...candidate,
        broker: { ...candidate.broker, executable: "/missing/factory-coordinator" },
      },
      checkedAt: "2026-08-13T20:04:00.000Z",
    });

    expect(report.passed).toBe(false);
    expect(report.blockers[0]).toMatch(/^broker-integrity:/u);
  });
});
