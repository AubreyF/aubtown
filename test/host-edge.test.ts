import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createHostEdgeServer } from "../src/gateway/edge-server.js";

const servers: ReturnType<typeof createHostEdgeServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
});

async function start(fetchImpl: typeof fetch): Promise<string> {
  const server = createHostEdgeServer({
    restateIngress: "http://restate.internal:8080/",
    fetchImpl,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Host edge did not open a TCP port.");
  }
  return `http://127.0.0.1:${address.port.toLocaleString("en-US", { useGrouping: false })}`;
}

describe("host edge", () => {
  it("forwards only the signed host submission route and required idempotency header", async () => {
    let forwardedUrl = "";
    let forwardedInit: RequestInit | undefined;
    const base = await start(async (input, init) => {
      forwardedUrl = String(input);
      forwardedInit = init;
      return Response.json({ accepted: true });
    });
    const response = await fetch(`${base}/HostGateway/macos-executor-1/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "host-macos-executor-1-1-deadbeef",
      },
      body: '{"signed":true}',
    });
    expect(response.status).toBe(200);
    expect(forwardedUrl).toBe(
      "http://restate.internal:8080/HostGateway/macos-executor-1/submit",
    );
    expect(new Headers(forwardedInit?.headers).get("idempotency-key")).toBe(
      "host-macos-executor-1-1-deadbeef",
    );
  });

  it("does not expose internal Restate objects or accept query-string route variants", async () => {
    const base = await start(async () => Response.json({ exposed: true }));
    const internal = await fetch(`${base}/ClaimRegistry/repository/read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "probe-1",
      },
      body: "{}",
    });
    expect(internal.status).toBe(404);
    const variant = await fetch(`${base}/HostGateway/host-1/submit?target=ClaimRegistry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "probe-2",
      },
      body: "{}",
    });
    expect(variant.status).toBe(404);
  });

  it("rejects missing idempotency and oversized bodies before forwarding", async () => {
    let calls = 0;
    const base = await start(async () => {
      calls += 1;
      return Response.json({ exposed: true });
    });
    const noKey = await fetch(`${base}/HostGateway/host-1/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noKey.status).toBe(400);
    const oversized = await fetch(`${base}/HostGateway/host-1/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "probe-3",
      },
      body: "x".repeat(1_024 * 1_024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(calls).toBe(0);
  });
});
