import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;
const HOST_ROUTE = /^\/HostGateway\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/submit$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;

export interface HostEdgeOptions {
  readonly restateIngress: string;
  readonly fetchImpl?: typeof fetch;
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body).toLocaleString("en-US", { useGrouping: false }),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RangeError("request-too-large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new RangeError("request-too-large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createHostEdgeServer(options: HostEdgeOptions): Server {
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = options.restateIngress.replace(/\/$/u, "");
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://host-edge.invalid");
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        respond(response, 200, '{"status":"ok"}\n');
        return;
      }
      if (
        request.method !== "POST" ||
        !HOST_ROUTE.test(requestUrl.pathname) ||
        requestUrl.search.length > 0
      ) {
        respond(response, 404, '{"error":"not-found"}\n');
        return;
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        respond(response, 415, '{"error":"content-type"}\n');
        return;
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        respond(response, 400, '{"error":"idempotency-key"}\n');
        return;
      }
      const body = await readBody(request);
      const forwarded = await fetchImpl(`${upstream}${requestUrl.pathname}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body,
      });
      const responseBody = new Uint8Array(await forwarded.arrayBuffer());
      response.writeHead(forwarded.status, {
        "content-type": forwarded.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "content-length": responseBody.length.toLocaleString("en-US", { useGrouping: false }),
      });
      response.end(responseBody);
    } catch (error) {
      if (error instanceof RangeError && error.message === "request-too-large") {
        respond(response, 413, '{"error":"request-too-large"}\n');
        return;
      }
      respond(response, 502, '{"error":"upstream-unavailable"}\n');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
