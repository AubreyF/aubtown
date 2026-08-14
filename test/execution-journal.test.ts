import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutorStartCommand } from "../src/execution/command.js";
import { HostExecutionJournal } from "../src/execution/journal.js";
import { claim, report } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

function command(commandId = "50e13459-412e-41f7-809f-0d91dc660d52") {
  return createExecutorStartCommand({
    commandId,
    claim: claim(),
    qualification: report(),
    authorityTaskId: "github-issue-1234",
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "b".repeat(40),
    issuedAt: "2026-08-13T18:00:00.000Z",
  });
}

describe("HostExecutionJournal", () => {
  it("persists one command and turn across process replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "aubtown-execution-"));
    roots.push(root);
    const file = join(root, "state", "execution.json");
    const journal = new HostExecutionJournal(file);
    await journal.accept(command(), "2026-08-13T18:00:01.000Z");
    await journal.started(command().commandId, {
      driverId: "codex-app-server-v1",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-08-13T18:00:02.000Z",
    });
    const preparation = await journal.prepareFinalization(command().commandId);
    const retriedPreparation = await journal.prepareFinalization(
      command().commandId,
    );
    expect(retriedPreparation.nonce).toBe(preparation.nonce);
    await journal.candidateFinalized(
      command().commandId,
      preparation.nonce,
      "1111111111111111111111111111111111111111",
    );
    const replacement = new HostExecutionJournal(file);
    await expect(replacement.read()).resolves.toMatchObject({
      stage: "started",
      handle: { threadId: "thread-1", turnId: "turn-1" },
      finalization: {
        nonce: preparation.nonce,
        head: "1111111111111111111111111111111111111111",
      },
    });
    await replacement.finish(
      command().commandId,
      "completed",
      "2026-08-13T18:10:00.000Z",
    );
    await replacement.reported(
      command().commandId,
      "2026-08-13T18:10:01.000Z",
    );
    await expect(replacement.read()).resolves.toMatchObject({
      stage: "completed",
      reportedAt: "2026-08-13T18:10:01.000Z",
    });
  });

  it("does not replace an active command with another claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "aubtown-execution-"));
    roots.push(root);
    const journal = new HostExecutionJournal(join(root, "execution.json"));
    await journal.accept(command(), "2026-08-13T18:00:01.000Z");
    await expect(
      journal.accept(
        command("1f040186-c388-4bb5-a2c8-ea9332581ee1"),
        "2026-08-13T18:00:02.000Z",
      ),
    ).rejects.toThrow("another active execution command");
  });
});
