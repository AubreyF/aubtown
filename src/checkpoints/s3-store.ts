import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { CheckpointStore, EncryptedCheckpointPayload } from "./store.js";
import {
  assertCheckpointReference,
  checkpointReference,
  decodeCheckpoint,
  encodeCheckpoint,
  MAX_STORED_CHECKPOINT_BYTES,
} from "./codec.js";

const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/u;

export interface S3CheckpointStoreOptions {
  readonly bucket: string;
  readonly prefix?: string;
}

export class S3CheckpointStore implements CheckpointStore {
  readonly #prefix: string;

  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly options: S3CheckpointStoreOptions,
  ) {
    if (!BUCKET_PATTERN.test(options.bucket)) {
      throw new Error("Checkpoint bucket name is invalid.");
    }
    const prefix = (options.prefix ?? "aubtown/checkpoints").replace(/\/+$/u, "");
    if (
      !PREFIX_PATTERN.test(prefix) ||
      prefix.startsWith("/") ||
      prefix.includes("..") ||
      prefix.includes("//")
    ) {
      throw new Error("Checkpoint object prefix is invalid.");
    }
    this.#prefix = prefix;
  }

  async put(payload: EncryptedCheckpointPayload): Promise<string> {
    const bytes = encodeCheckpoint(payload);
    const reference = checkpointReference(bytes);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: this.#activeKey(reference),
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: "application/vnd.aubtown.checkpoint+json",
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
          IfNoneMatch: "*",
          Metadata: {
            checkpointReference: reference,
            claimId: payload.manifest.claimId,
            custodyEpoch: payload.manifest.custodyEpoch.toLocaleString("en-US", {
              useGrouping: false,
            }),
          },
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      const existing = await this.#readBytes(this.#activeKey(reference));
      if (existing === undefined || checkpointReference(existing) !== reference) {
        throw new Error("Checkpoint object key exists with different bytes.");
      }
    }
    return reference;
  }

  async get(reference: string): Promise<EncryptedCheckpointPayload | undefined> {
    assertCheckpointReference(reference);
    const bytes = await this.#readBytes(this.#activeKey(reference));
    if (bytes === undefined) {
      return undefined;
    }
    if (checkpointReference(bytes) !== reference) {
      throw new Error("Stored checkpoint digest does not match its reference.");
    }
    return decodeCheckpoint(bytes);
  }

  async retire(reference: string, retiredAt: string): Promise<void> {
    assertCheckpointReference(reference);
    if (!Number.isFinite(Date.parse(retiredAt))) {
      throw new Error("Checkpoint retirement timestamp must be valid ISO time.");
    }
    const activeKey = this.#activeKey(reference);
    const retiredKey = this.#retiredKey(reference, retiredAt);
    const activeBytes = await this.#readBytes(activeKey);
    if (activeBytes === undefined) {
      const retiredBytes = await this.#readBytes(retiredKey);
      if (retiredBytes === undefined) {
        throw new Error("Checkpoint cannot be retired because it does not exist.");
      }
      if (checkpointReference(retiredBytes) !== reference) {
        throw new Error("Retired checkpoint digest does not match its reference.");
      }
      return;
    }
    if (checkpointReference(activeBytes) !== reference) {
      throw new Error("Checkpoint cannot be retired because its digest is invalid.");
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: retiredKey,
        CopySource: encodeURIComponent(`${this.options.bucket}/${activeKey}`),
        MetadataDirective: "COPY",
      }),
    );
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: activeKey,
      }),
    );
  }

  #activeKey(reference: string): string {
    return `${this.#prefix}/active/${reference}.checkpoint`;
  }

  #retiredKey(reference: string, retiredAt: string): string {
    const timestampDigest = createHash("sha256").update(retiredAt).digest("hex").slice(0, 16);
    return `${this.#prefix}/retired/${reference}.${timestampDigest}.checkpoint`;
  }

  async #readBytes(key: string): Promise<Uint8Array | undefined> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > MAX_STORED_CHECKPOINT_BYTES
    ) {
      throw new Error("Stored checkpoint exceeds the store size limit.");
    }
    if (response.Body === undefined) {
      throw new Error("Checkpoint object response has no body.");
    }
    const bytes = await response.Body.transformToByteArray();
    if (bytes.length > MAX_STORED_CHECKPOINT_BYTES) {
      throw new Error("Stored checkpoint exceeds the store size limit.");
    }
    return bytes;
  }
}

function statusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const metadata = "$metadata" in error
    ? (error as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata
    : undefined;
  return metadata?.httpStatusCode;
}

function isMissing(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined;
  return statusCode(error) === 404 || name === "NoSuchKey" || name === "NotFound";
}

function isPreconditionFailure(error: unknown): boolean {
  return statusCode(error) === 412 || (error instanceof Error && error.name === "PreconditionFailed");
}
