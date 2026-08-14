import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymphonyActiveTurnJournal } from "../src/integrations/symphony/active-turn-journal.js";
import { FREED_REPOSITORY } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function journal(): Promise<SymphonyActiveTurnJournal> {
  const root = await realpath(
    await mkdtemp(path.join(await realpath(os.tmpdir()), "aubtown-turn-")),
  );
  roots.push(root);
  return new SymphonyActiveTurnJournal(path.join(root, "turns"));
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: "symphony-active-turn" as const,
    manifestDigest: "a".repeat(64),
    repository: FREED_REPOSITORY,
    issueNumber: 1_234,
    claimId: "claim-1234",
    custodyEpoch: 1 as const,
    hostId: "linux-control-1",
    workerId: "worker-1",
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    threadId: "thread-1",
    turnId: "turn-1",
    observedAt: "2026-08-13T18:00:00.000Z",
    ...overrides,
  };
}

describe("Symphony active-turn journal", () => {
  it("keeps the latest exact implementation turn across coordinator restart", async () => {
    const store = await journal();
    await store.record(record());
    const latest = record({
      turnId: "turn-2",
      observedAt: "2026-08-13T18:01:00.000Z",
    });
    await store.record(latest);
    await expect(store.load("a".repeat(64))).resolves.toEqual(latest);
  });

  it("rejects backward time and changed custody", async () => {
    const store = await journal();
    await store.record(record());
    await expect(
      store.record(record({ observedAt: "2026-08-13T17:59:59.000Z" })),
    ).rejects.toThrow("cannot move backward");
    await expect(
      store.record(
        record({
          claimId: "another-claim",
          observedAt: "2026-08-13T18:01:00.000Z",
        }),
      ),
    ).rejects.toThrow("changes admitted custody");
  });
});
