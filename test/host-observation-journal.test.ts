import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostObservationJournal } from "../src/gateway/host-observation-journal.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";
import { signHostEnvelope } from "../src/security/host-envelope.js";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const roots: string[] = [];
const hostKeys = keyPair();
const enrollments: HostEnrollments = {
  "linux-control-1": {
    enabled: true,
    lane: "linux",
    accountIds: ["codex-pro-1"],
    publicKeyPem: hostKeys.publicKey,
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function journalPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-host-observations-"));
  roots.push(root);
  return path.join(root, "state", "observations.json");
}

function heartbeat(sequence: number, activeClaims: readonly string[] = []) {
  return signHostEnvelope(
    {
      schemaVersion: 1,
      hostId: "linux-control-1",
      sequence,
      issuedAt: "2026-08-13T18:00:00.000Z",
      kind: "heartbeat",
      payload: {
        hostId: "linux-control-1",
        lane: "linux",
        observedAt: "2026-08-13T18:00:00.000Z",
        activeClaims: [...activeClaims],
        accountIds: ["codex-pro-1"],
      },
    },
    hostKeys.privateKey,
  );
}

function quota(input: {
  readonly sequence: number;
  readonly observedAt: string;
  readonly usedPercent: number;
}) {
  return signHostEnvelope(
    {
      schemaVersion: 1,
      hostId: "linux-control-1",
      sequence: input.sequence,
      issuedAt: input.observedAt,
      kind: "quota-observation",
      payload: {
        observation: {
          accountId: "codex-pro-1",
          observedAt: input.observedAt,
          primary: {
            usedPercent: input.usedPercent,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-08-18T08:00:00.000Z",
          },
          activeTurnIds: [],
        },
      },
    },
    hostKeys.privateKey,
  );
}

describe("host observation journal", () => {
  it("persists an authenticated heartbeat and exact retry across restart", async () => {
    const file = await journalPath();
    const event = heartbeat(1, ["claim-1234"]);
    const first = await new HostObservationJournal(file, enrollments).accept(
      event,
      "2026-08-13T18:00:01.000Z",
    );
    expect(first).toMatchObject({
      acceptedNow: true,
      receipt: {
        kind: "heartbeat",
        host: { id: "linux-control-1", activeClaims: ["claim-1234"] },
      },
    });
    const replacement = new HostObservationJournal(file, enrollments);
    await expect(
      replacement.accept(event, "2026-08-13T18:00:02.000Z"),
    ).resolves.toMatchObject({
      acceptedNow: false,
      receipt: { acceptedAt: "2026-08-13T18:00:01.000Z" },
    });
    await expect(replacement.snapshot()).resolves.toMatchObject({
      revision: 1,
      hosts: [{ id: "linux-control-1", online: true }],
    });
  });

  it("preserves one daily baseline while weekly use advances", async () => {
    const file = await journalPath();
    const journal = new HostObservationJournal(file, enrollments);
    await journal.accept(
      quota({
        sequence: 1,
        observedAt: "2026-08-13T18:00:00.000Z",
        usedPercent: 30,
      }),
      "2026-08-13T18:00:01.000Z",
    );
    const second = await journal.accept(
      quota({
        sequence: 2,
        observedAt: "2026-08-13T18:01:00.000Z",
        usedPercent: 38,
      }),
      "2026-08-13T18:01:01.000Z",
    );
    expect(second.receipt).toMatchObject({
      kind: "quota-observation",
      decision: {
        action: "throttle",
        reason: "daily-throttle",
        dailyUsedPercent: 8,
      },
    });
    await expect(journal.snapshot()).resolves.toMatchObject({
      usageByAccountId: {
        "codex-pro-1": {
          observedAt: "2026-08-13T18:01:00.000Z",
          dailyBaseline: {
            observedAt: "2026-08-13T18:00:00.000Z",
            usedPercent: 30,
          },
        },
      },
    });
  });

  it("rejects stale, conflicting, and out-of-scope observations", async () => {
    const file = await journalPath();
    const journal = new HostObservationJournal(file, enrollments);
    await journal.accept(heartbeat(2), "2026-08-13T18:00:01.000Z");
    await expect(
      journal.accept(heartbeat(1), "2026-08-13T18:00:02.000Z"),
    ).rejects.toThrow("sequence is stale");
    await expect(
      journal.accept(heartbeat(2, ["another-claim"]), "2026-08-13T18:00:02.000Z"),
    ).rejects.toThrow("sequence is stale or conflicting");

    const outside = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "linux-control-1",
        sequence: 3,
        issuedAt: "2026-08-13T18:00:02.000Z",
        kind: "quota-observation",
        payload: {
          observation: {
            accountId: "another-subscription",
            observedAt: "2026-08-13T18:00:02.000Z",
            primary: {
              usedPercent: 1,
              windowDurationMinutes: 10_080,
              resetsAt: "2026-08-18T08:00:00.000Z",
            },
            activeTurnIds: [],
          },
        },
      },
      hostKeys.privateKey,
    );
    await expect(
      journal.accept(outside, "2026-08-13T18:00:03.000Z"),
    ).rejects.toThrow("enrolled account scope");
  });

  it("rejects an older account sample and an unsafe journal file", async () => {
    const file = await journalPath();
    const journal = new HostObservationJournal(file, enrollments);
    await journal.accept(
      quota({
        sequence: 1,
        observedAt: "2026-08-13T18:01:00.000Z",
        usedPercent: 30,
      }),
      "2026-08-13T18:01:01.000Z",
    );
    await expect(
      journal.accept(
        quota({
          sequence: 2,
          observedAt: "2026-08-13T18:00:00.000Z",
          usedPercent: 20,
        }),
        "2026-08-13T18:01:02.000Z",
      ),
    ).rejects.toThrow("older than the account snapshot");
    await chmod(file, 0o666);
    await expect(
      new HostObservationJournal(file, enrollments).snapshot(),
    ).rejects.toThrow("protected physical file");
  });

  it("rejects a signature made by another host key", async () => {
    const file = await journalPath();
    const attacker = keyPair();
    const forged = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "linux-control-1",
        sequence: 1,
        issuedAt: "2026-08-13T18:00:00.000Z",
        kind: "heartbeat",
        payload: {
          hostId: "linux-control-1",
          lane: "linux",
          observedAt: "2026-08-13T18:00:00.000Z",
          activeClaims: [],
          accountIds: ["codex-pro-1"],
        },
      },
      attacker.privateKey,
    );
    await expect(
      new HostObservationJournal(file, enrollments).accept(
        forged,
        "2026-08-13T18:00:01.000Z",
      ),
    ).rejects.toThrow("signature is invalid");
  });

  it("rejects coordinator time rollback for a new sequence", async () => {
    const file = await journalPath();
    const journal = new HostObservationJournal(file, enrollments);
    await journal.accept(heartbeat(1), "2026-08-13T18:00:01.000Z");
    await expect(
      journal.accept(heartbeat(2), "2026-08-13T17:59:59.000Z"),
    ).rejects.toThrow("cannot move backward");
  });
});
