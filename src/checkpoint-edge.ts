import { S3Client } from "@aws-sdk/client-s3";
import { LocalCheckpointStore } from "./checkpoints/local-store.js";
import { S3CheckpointStore } from "./checkpoints/s3-store.js";
import type { CheckpointStore } from "./checkpoints/store.js";
import { createCheckpointServer } from "./gateway/checkpoint-server.js";
import {
  loadHostEnrollments,
  loadPrivateKeyPem,
  loadPublicKeyPem,
} from "./security/host-enrollment.js";
import { CheckpointStorageReceiptIssuer } from "./checkpoints/receipt.js";
import { parseBindHost, parseServicePort } from "./config/network.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
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

const port = parseServicePort(process.env.PORT, 8_091);
const bindHost = parseBindHost(process.env.FREEDWORKS_BIND_HOST);
const server = createCheckpointServer({
  store: checkpointStore(),
  hostEnrollments: await loadHostEnrollments(process.env),
  grantPublicKeyPem: await loadPublicKeyPem(
    requiredEnvironment("FREEDWORKS_CHECKPOINT_GRANT_PUBLIC_KEY_FILE"),
    "Checkpoint grant public key",
  ),
  storageReceiptIssuer: new CheckpointStorageReceiptIssuer(
    await loadPrivateKeyPem(
      requiredEnvironment("FREEDWORKS_CHECKPOINT_RECEIPT_PRIVATE_KEY_FILE"),
      "Checkpoint receipt private key",
    ),
  ),
});
server.listen(port, bindHost, () => {
  process.stdout.write(
    `Freedworks checkpoint edge listening on ${bindHost}:${port.toLocaleString()}.\n`,
  );
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
