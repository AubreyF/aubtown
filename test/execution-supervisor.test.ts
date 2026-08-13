import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerDriver, WorkerTurnHandle } from "../src/drivers/worker.js";
import { createExecutorStartCommand } from "../src/execution/command.js";
import { HostExecutionJournal } from "../src/execution/journal.js";
import { HostExecutionSupervisor } from "../src/execution/supervisor.js";
import type { ExecutionCheckpointManager } from "../src/execution/checkpoint-manager.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { claim, report } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

const handle: WorkerTurnHandle = {
  driverId: "fake",
  threadId: "thread-1",
  turnId: "turn-1",
  startedAt: "2026-08-13T18:00:01.000Z",
};

function command() {
  return createExecutorStartCommand({
    commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
    claim: claim(),
    qualification: report(),
    authorityTaskId: "github-issue-1234",
    accountId: "codex-pro-1",
    issuedAt: "2026-08-13T18:00:00.000Z",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("HostExecutionSupervisor", () => {
  it("starts once, records before reporting, and persists completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-supervisor-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    const completion = deferred<"completed" | "interrupted" | "failed">();
    let starts = 0;
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => {
        starts += 1;
        return handle;
      },
      recover: async () => "running" as const,
      wait: async () => await completion.promise,
      interrupt: async () => {},
    } satisfies WorkerDriver;
    const reports: string[] = [];
    const tracked: string[] = [];
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async (receipt) => {
          reports.push(receipt.stage);
          return {
            kind: "executor-receipt",
            hostId: "linux-control-1",
            sequence: reports.length,
            acceptedAt: "2026-08-13T18:00:02.000Z",
            commandId: receipt.commandId,
            stage: receipt.stage,
          };
        },
        reconcileExecutor: async (request) => ({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          commandId: request.commandId,
          action: "resume",
          reason: "current",
        }),
      },
      {
        track: (_accountId, turn) => tracked.push(`track:${turn.turnId}`),
        untrack: (_accountId, turnId) => tracked.push(`untrack:${turnId}`),
      },
      () => {},
      () => new Date("2026-08-13T18:00:02.000Z"),
    );
    await supervisor.accept(command());
    await supervisor.accept(command());
    expect(starts).toBe(1);
    expect(reports).toEqual(["started"]);
    expect(await supervisor.activeClaimIds()).toEqual(["claim-1234"]);
    completion.resolve("completed");
    for (let attempt = 0; attempt < 20 && reports.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reports).toEqual(["started", "completed"]);
    expect(tracked).toEqual([
      "track:turn-1",
      "track:turn-1",
      "untrack:turn-1",
    ]);
    await expect(journal.read()).resolves.toMatchObject({
      stage: "completed",
      reportedAt: "2026-08-13T18:00:02.000Z",
    });
  });

  it("recovers a persisted turn without starting a duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-supervisor-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    await journal.accept(command(), "2026-08-13T18:00:00.000Z");
    await journal.started(command().commandId, handle);
    let starts = 0;
    let recovers = 0;
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => {
        starts += 1;
        return handle;
      },
      recover: async () => {
        recovers += 1;
        return "running" as const;
      },
      wait: async () => await new Promise<"completed">(() => {}),
      interrupt: async () => {},
    } satisfies WorkerDriver;
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async (receipt) => ({
          kind: "executor-receipt",
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          commandId: receipt.commandId,
          stage: receipt.stage,
        }),
        reconcileExecutor: async (request) => ({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          commandId: request.commandId,
          action: "resume",
          reason: "current",
        }),
      },
      { track: () => {}, untrack: () => {} },
      () => {},
      () => new Date("2026-08-13T18:00:02.000Z"),
    );
    await supervisor.recover();
    await supervisor.recover();
    expect(starts).toBe(0);
    expect(recovers).toBe(1);
    await expect(journal.read()).resolves.toMatchObject({
      stage: "started",
      reportedAt: "2026-08-13T18:00:02.000Z",
    });
  });

  it("persists capture and storage before retrying catalog admission and terminal reporting", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-supervisor-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    const completion = deferred<"completed" | "interrupted" | "failed">();
    const manifest = createCheckpointManifest({
      claim: claim(),
      repositoryHead: "a".repeat(40),
      baseHead: "b".repeat(40),
      patch: new TextEncoder().encode("diff --git a/a b/a\n"),
      includedUntrackedPaths: [],
      validationReceipts: ["worker-turn:completed"],
      createdAt: "2026-08-13T18:00:02.000Z",
    });
    const reference = "d".repeat(64);
    let captures = 0;
    let uploads = 0;
    let catalogs = 0;
    const checkpoints: ExecutionCheckpointManager = {
      capture: async () => {
        captures += 1;
        return { reference, manifest };
      },
      upload: async () => {
        uploads += 1;
        return {
          schemaVersion: 1,
          reference,
          contentLength: 1_024,
          hostId: "linux-control-1",
          grantNonce: "11111111-1111-4111-8111-111111111111",
          manifest,
          storedAt: "2026-08-13T18:00:03.000Z",
          signatureBase64: "edge-signature",
        };
      },
      catalog: async () => {
        catalogs += 1;
        if (catalogs === 1) {
          throw new Error("catalog temporarily unavailable");
        }
      },
    };
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => handle,
      recover: async () => "running" as const,
      wait: async () => await completion.promise,
      interrupt: async () => {},
    } satisfies WorkerDriver;
    const reports: string[] = [];
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async (receipt) => {
          reports.push(receipt.stage);
          return {
            kind: "executor-receipt",
            hostId: "linux-control-1",
            sequence: reports.length,
            acceptedAt: "2026-08-13T18:00:04.000Z",
            commandId: receipt.commandId,
            stage: receipt.stage,
          };
        },
        reconcileExecutor: async (request) => ({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:04.000Z",
          commandId: request.commandId,
          action: "resume",
          reason: "current",
        }),
      },
      { track: () => {}, untrack: () => {} },
      () => {},
      () => new Date("2026-08-13T18:00:04.000Z"),
      checkpoints,
    );

    await supervisor.accept(command());
    completion.resolve("completed");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await journal.read();
      if (current?.checkpoint?.storageReceipt !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const storedCheckpoint = await journal.read();
    expect(storedCheckpoint).toMatchObject({
      stage: "completed",
      checkpoint: { reference, storageReceipt: { reference } },
    });
    expect(storedCheckpoint?.reportedAt).toBeUndefined();
    await supervisor.flush();

    expect({ captures, uploads, catalogs }).toEqual({
      captures: 1,
      uploads: 1,
      catalogs: 2,
    });
    expect(reports).toEqual(["started", "completed"]);
    await expect(journal.read()).resolves.toMatchObject({
      checkpoint: {
        reference,
        catalogedAt: "2026-08-13T18:00:04.000Z",
      },
      reportedAt: "2026-08-13T18:00:04.000Z",
    });
  });

  it("fails closed when a crash leaves the start outcome ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-supervisor-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    await journal.accept(command(), "2026-08-13T18:00:00.000Z");
    let starts = 0;
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => {
        starts += 1;
        return handle;
      },
      recover: async () => "running" as const,
      wait: async () => await new Promise<"completed">(() => {}),
      interrupt: async () => {},
    } satisfies WorkerDriver;
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async () => {
          throw new Error("should not report");
        },
        reconcileExecutor: async () => {
          throw new Error("should not reconcile");
        },
      },
      { track: () => {}, untrack: () => {} },
      () => {},
    );
    await expect(supervisor.recover()).rejects.toThrow("requires reconciliation");
    await expect(supervisor.accept(command())).rejects.toThrow(
      "requires reconciliation",
    );
    expect(starts).toBe(0);
  });

  it("quarantines a stale persisted turn before app-server resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "freedworks-supervisor-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    await journal.accept(command(), "2026-08-13T18:00:00.000Z");
    await journal.started(command().commandId, handle);
    let recovers = 0;
    const events: Array<Record<string, unknown>> = [];
    const worker = {
      id: "fake",
      capabilities: {
        hostLanes: ["linux"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "none",
      },
      start: async () => handle,
      recover: async () => {
        recovers += 1;
        return "running" as const;
      },
      wait: async () => await new Promise<"completed">(() => {}),
      interrupt: async () => {},
    } satisfies WorkerDriver;
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async () => {
          throw new Error("should not report");
        },
        reconcileExecutor: async (request) => ({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 1,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          commandId: request.commandId,
          action: "quarantine",
          reason: "claim-stale",
        }),
      },
      { track: () => {}, untrack: () => {} },
      (event) => events.push(event),
    );
    await supervisor.recover();
    expect(recovers).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "executor-turn-quarantined",
        reason: "claim-stale",
      }),
    );
  });
});
