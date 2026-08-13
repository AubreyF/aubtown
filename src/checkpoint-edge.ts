import { lstat, readFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { LocalCheckpointStore } from "./checkpoints/local-store.js";
import { S3CheckpointStore } from "./checkpoints/s3-store.js";
import type { CheckpointStore } from "./checkpoints/store.js";
import { createCheckpointServer } from "./gateway/checkpoint-server.js";
import { loadHostEnrollments } from "./security/host-enrollment.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function readPhysicalPublicKey(file: string): Promise<string> {
  if (!file.startsWith("/")) {
    throw new Error("Checkpoint grant public key path must be absolute.");
  }
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1_024) {
    throw new Error("Checkpoint grant public key must be a small physical file.");
  }
  return await readFile(file, "utf8");
}

function checkpointStore(): CheckpointStore {
  const localRoot = process.env.FREEDWORKS_CHECKPOINT_STORE_ROOT?.trim();
  const s3Bucket = process.env.FREEDWORKS_CHECKPOINT_S3_BUCKET?.trim();
  if (localRoot !== undefined && localRoot.length > 0 && s3Bucket !== undefined && s3Bucket.length > 0) {
    throw new Error("Configure one checkpoint store, not both local and S3.");
  }
  if (s3Bucket !== undefined && s3Bucket.length > 0) {
    const region = requiredEnvironment("FREEDWORKS_CHECKPOINT_S3_REGION");
    const endpoint = process.env.FREEDWORKS_CHECKPOINT_S3_ENDPOINT?.trim();
    const client = new S3Client({
      region,
      ...(endpoint === undefined || endpoint.length === 0
        ? {}
        : { endpoint, forcePathStyle: true }),
    });
    return new S3CheckpointStore(client, {
      bucket: s3Bucket,
      ...(process.env.FREEDWORKS_CHECKPOINT_S3_PREFIX === undefined
        ? {}
        : { prefix: process.env.FREEDWORKS_CHECKPOINT_S3_PREFIX }),
    });
  }
  return new LocalCheckpointStore(
    localRoot === undefined || localRoot.length === 0
      ? "/var/lib/freedworks/checkpoints"
      : localRoot,
  );
}

const port = Number(process.env.PORT ?? "8091");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 through 65,535.");
}
const server = createCheckpointServer({
  store: checkpointStore(),
  hostEnrollments: await loadHostEnrollments(process.env),
  grantPublicKeyPem: await readPhysicalPublicKey(
    requiredEnvironment("FREEDWORKS_CHECKPOINT_GRANT_PUBLIC_KEY_FILE"),
  ),
});
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Freedworks checkpoint edge listening on ${port.toLocaleString()}.\n`);
});

function stop(): void {
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
