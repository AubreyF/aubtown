import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HostObservationJournal } from "../src/gateway/host-observation-journal.js";
import { createHostObservationServer } from "../src/gateway/host-observation-server.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";
import {
  hostEnvelopeDigest,
  signHostEnvelope,
} from "../src/security/host-envelope.js";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function fixture() {
  const keys = keyPair();
  const enrollments: HostEnrollments = {
    "linux-control-1": {
      enabled: true,
      lane: "linux",
      accountIds: ["codex-pro-1"],
      publicKeyPem: keys.publicKey,
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "aubtown-host-gateway-"));
  roots.push(root);
  const journal = new HostObservationJournal(
    path.join(root, "observations.json"),
    enrollments,
  );
  const denials: string[] = [];
  const server = createHostObservationServer({
    journal,
    now: () => new Date("2026-08-13T18:00:01.000Z"),
    onDenial: (reason) => denials.push(reason),
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    keys,
    journal,
    denials,
    url: `http://127.0.0.1:${address.port.toLocaleString("en-US", {
      useGrouping: false,
    })}`,
  };
}

function heartbeat(privateKey: string) {
  return signHostEnvelope(
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
    privateKey,
  );
}

function requestHeaders(envelope: ReturnType<typeof heartbeat>) {
  return {
    "content-type": "application/json",
    "idempotency-key": `host-${envelope.hostId}-${envelope.sequence.toLocaleString(
      "en-US",
      { useGrouping: false },
    )}-${hostEnvelopeDigest(envelope).slice(0, 16)}`,
  };
}

describe("host observation server", () => {
  it("accepts a signed event and returns the durable exact retry", async () => {
    const state = await fixture();
    const envelope = heartbeat(state.keys.privateKey);
    const endpoint = `${state.url}/HostGateway/linux-control-1/submit`;
    const first = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(envelope),
      body: JSON.stringify(envelope),
    });
    expect(first.status).toBe(201);
    const firstReceipt = await first.json();
    expect(firstReceipt).toMatchObject({
      kind: "heartbeat",
      hostId: "linux-control-1",
      acceptedAt: "2026-08-13T18:00:01.000Z",
    });
    const retry = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(envelope),
      body: JSON.stringify(envelope),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstReceipt);
    await expect(state.journal.snapshot()).resolves.toMatchObject({ revision: 1 });
  });

  it("serves loopback health without exposing state", async () => {
    const state = await fixture();
    const response = await fetch(`${state.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect((await fetch(`${state.url}/snapshot`)).status).toBe(404);
  });

  it("rejects a request whose idempotency key does not bind the envelope", async () => {
    const state = await fixture();
    const envelope = heartbeat(state.keys.privateKey);
    const response = await fetch(
      `${state.url}/HostGateway/linux-control-1/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "wrong",
        },
        body: JSON.stringify(envelope),
      },
    );
    expect(response.status).toBe(403);
    expect(state.denials).toEqual(["idempotency-key-mismatch"]);
  });

  it("keeps non-observation host commands closed", async () => {
    const state = await fixture();
    const envelope = signHostEnvelope(
      {
        schemaVersion: 1,
        hostId: "linux-control-1",
        sequence: 1,
        issuedAt: "2026-08-13T18:00:00.000Z",
        kind: "executor-poll",
        payload: { accountId: "codex-pro-1" },
      },
      state.keys.privateKey,
    );
    const response = await fetch(
      `${state.url}/HostGateway/linux-control-1/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `host-${envelope.hostId}-1-${hostEnvelopeDigest(
            envelope,
          ).slice(0, 16)}`,
        },
        body: JSON.stringify(envelope),
      },
    );
    expect(response.status).toBe(403);
    expect(state.denials).toEqual([
      "Host observation journal accepts only heartbeat and quota envelopes.",
    ]);
  });
});
