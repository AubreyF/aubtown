import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CheckpointStore } from "../checkpoints/store.js";
import {
  checkpointReference,
  decodeCheckpoint,
  encodeCheckpoint,
  MAX_STORED_CHECKPOINT_BYTES,
} from "../checkpoints/codec.js";
import {
  parseSignedCheckpointGrant,
  verifyCheckpointGrant,
} from "../checkpoints/grant.js";
import {
  decodeCheckpointAuthorization,
  parseSignedCheckpointProof,
  verifyCheckpointProof,
} from "../checkpoints/proof.js";
import type { HostEnrollments } from "../security/host-enrollment.js";
import { CheckpointStorageReceiptIssuer } from "../checkpoints/receipt.js";

const ROUTE = /^\/v1\/checkpoints\/([0-9a-f]{64})$/u;
const EMPTY_DIGEST = createHash("sha256").update(new Uint8Array()).digest("hex");

export interface CheckpointServerOptions {
  readonly store: CheckpointStore;
  readonly hostEnrollments: HostEnrollments;
  readonly grantPublicKeyPem: string;
  readonly storageReceiptIssuer: CheckpointStorageReceiptIssuer;
  readonly now?: () => Date;
  readonly onDenial?: (reason: string) => void;
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body).toLocaleString("en-US", { useGrouping: false }),
  });
  response.end(body);
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required ${name} header is missing.`);
  }
  return value;
}

async function readExactBody(request: IncomingMessage, expected: number): Promise<Uint8Array> {
  if (expected > MAX_STORED_CHECKPOINT_BYTES) {
    throw new RangeError("request-too-large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > expected || size > MAX_STORED_CHECKPOINT_BYTES) {
      throw new RangeError("request-size-mismatch");
    }
    chunks.push(chunk);
  }
  if (size !== expected) {
    throw new RangeError("request-size-mismatch");
  }
  return Buffer.concat(chunks);
}

function assertManifestMatchesGrant(
  manifest: ReturnType<typeof decodeCheckpoint>["manifest"],
  grant: ReturnType<typeof parseSignedCheckpointGrant>,
): void {
  if (
    manifest.repository.owner !== grant.repository.owner ||
    manifest.repository.name !== grant.repository.name ||
    manifest.repository.defaultBranch !== grant.repository.defaultBranch ||
    manifest.issueNumber !== grant.issueNumber ||
    manifest.claimId !== grant.claimId ||
    manifest.custodyEpoch !== grant.checkpointEpoch
  ) {
    throw new Error("Checkpoint object manifest does not match its transfer grant.");
  }
}

export function createCheckpointServer(options: CheckpointServerOptions): Server {
  const now = options.now ?? (() => new Date());
  const onDenial =
    options.onDenial ??
    ((reason: string) => {
      process.stderr.write(
        `${JSON.stringify({ event: "checkpoint-transfer-denied", reason })}\n`,
      );
    });
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://checkpoint-edge.invalid");
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        respond(response, 200, '{"status":"ok"}\n');
        return;
      }
      const match = ROUTE.exec(requestUrl.pathname);
      if (
        match === null ||
        requestUrl.search.length > 0 ||
        (request.method !== "PUT" && request.method !== "GET")
      ) {
        respond(response, 404, '{"error":"not-found"}\n');
        return;
      }
      const reference = match[1]!;
      const authorization = header(request, "authorization");
      if (!authorization.startsWith("FreedworksGrant ")) {
        respond(response, 401, '{"error":"authorization"}\n');
        return;
      }
      const grant = parseSignedCheckpointGrant(
        decodeCheckpointAuthorization(authorization.slice("FreedworksGrant ".length)),
      );
      const proof = parseSignedCheckpointProof(
        decodeCheckpointAuthorization(header(request, "x-freedworks-host-proof")),
      );
      const enrollment = options.hostEnrollments[grant.hostId];
      if (enrollment === undefined || !enrollment.enabled) {
        respond(response, 403, '{"error":"host-enrollment"}\n');
        return;
      }
      const method = request.method;
      const acceptedAt = now().toISOString();
      const expectedOperation = method === "PUT" ? "upload" : "download";
      verifyCheckpointGrant({
        grant,
        publicKeyPem: options.grantPublicKeyPem,
        now: acceptedAt,
        expectedHostId: proof.hostId,
        expectedOperation,
        expectedReference: reference,
        expectedContentLength: grant.contentLength,
      });
      const verifiedProof = verifyCheckpointProof({
        proof,
        publicKeyPem: enrollment.publicKeyPem,
        now: acceptedAt,
        expectedHostId: grant.hostId,
        expectedGrantNonce: grant.nonce,
        expectedMethod: method,
        expectedPath: requestUrl.pathname,
      });
      if (method === "PUT") {
        const declaredLength = Number(header(request, "content-length"));
        if (declaredLength !== grant.contentLength) {
          throw new RangeError("request-size-mismatch");
        }
        const bytes = await readExactBody(request, grant.contentLength);
        if (
          checkpointReference(bytes) !== reference ||
          verifiedProof.bodyDigest !== reference
        ) {
          throw new Error("Checkpoint upload digest does not match its grant.");
        }
        const payload = decodeCheckpoint(bytes);
        assertManifestMatchesGrant(payload.manifest, grant);
        if (payload.manifest.sourceHostId !== grant.hostId) {
          throw new Error("Checkpoint upload source host does not match its grant.");
        }
        const storedReference = await options.store.put(payload);
        if (storedReference !== reference) {
          throw new Error("Checkpoint store returned a different content address.");
        }
        const receipt = options.storageReceiptIssuer.issue({
          schemaVersion: 1,
          reference,
          contentLength: bytes.length,
          hostId: grant.hostId,
          grantNonce: grant.nonce,
          manifest: payload.manifest,
          storedAt: acceptedAt,
        });
        respond(response, 201, `${JSON.stringify({ reference, receipt })}\n`);
        return;
      }
      if (
        request.headers["transfer-encoding"] !== undefined ||
        Number(request.headers["content-length"] ?? "0") !== 0
      ) {
        throw new RangeError("download-request-body-forbidden");
      }
      if (verifiedProof.bodyDigest !== EMPTY_DIGEST) {
        throw new Error("Checkpoint download proof must bind an empty request body.");
      }
      const payload = await options.store.get(reference);
      if (payload === undefined) {
        respond(response, 404, '{"error":"checkpoint-not-found"}\n');
        return;
      }
      assertManifestMatchesGrant(payload.manifest, grant);
      const bytes = encodeCheckpoint(payload);
      if (bytes.length !== grant.contentLength || checkpointReference(bytes) !== reference) {
        throw new Error("Checkpoint download does not match its transfer grant.");
      }
      response.writeHead(200, {
        "content-type": "application/vnd.freedworks.checkpoint+json",
        "cache-control": "no-store",
        "content-length": bytes.length.toLocaleString("en-US", { useGrouping: false }),
      });
      response.end(bytes);
    } catch (error) {
      if (error instanceof RangeError) {
        onDenial(error.message);
        respond(response, 413, '{"error":"request-size"}\n');
        return;
      }
      onDenial(error instanceof Error ? error.message : "unknown");
      respond(response, 403, '{"error":"checkpoint-transfer-denied"}\n');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
