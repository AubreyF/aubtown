import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  hostEnvelopeDigest,
  parseSignedHostEnvelope,
} from "../security/host-envelope.js";
import type { HostObservationJournal } from "./host-observation-journal.js";

const ROUTE = /^\/HostGateway\/([^/]+)\/submit$/u;
const MAX_BODY_BYTES = 1024 * 1024;

export interface HostObservationServerOptions {
  readonly journal: HostObservationJournal;
  readonly now?: () => Date;
  readonly onDenial?: (reason: string) => void;
}

function respond(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body).toLocaleString("en-US", {
      useGrouping: false,
    }),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new RangeError("request-too-large");
    }
    chunks.push(chunk);
  }
  if (size < 1) {
    throw new Error("request-body-empty");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createHostObservationServer(
  options: HostObservationServerOptions,
): Server {
  const now = options.now ?? (() => new Date());
  const onDenial = options.onDenial ?? (() => {});
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://host-gateway.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        respond(response, 200, { status: "ok" });
        return;
      }
      const route = ROUTE.exec(url.pathname);
      if (
        request.method !== "POST" ||
        route === null ||
        url.search.length > 0
      ) {
        respond(response, 404, { error: "not-found" });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new Error("content-type-invalid");
      }
      const routeHostId = decodeURIComponent(route[1] ?? "");
      const envelope = parseSignedHostEnvelope(await readBody(request));
      if (envelope.hostId !== routeHostId) {
        throw new Error("route-host-mismatch");
      }
      const expectedIdempotencyKey = `host-${envelope.hostId}-${envelope.sequence.toLocaleString(
        "en-US",
        { useGrouping: false },
      )}-${hostEnvelopeDigest(envelope).slice(0, 16)}`;
      if (request.headers["idempotency-key"] !== expectedIdempotencyKey) {
        throw new Error("idempotency-key-mismatch");
      }
      const accepted = await options.journal.accept(
        envelope,
        now().toISOString(),
      );
      respond(response, accepted.acceptedNow ? 201 : 200, accepted.receipt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      onDenial(reason);
      if (error instanceof RangeError) {
        respond(response, 413, { error: "request-too-large" });
        return;
      }
      respond(response, 403, { error: "host-observation-denied" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
