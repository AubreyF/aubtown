import { randomBytes } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { S3CheckpointStore } from "../src/checkpoints/s3-store.js";
import type { CheckpointKeyProvider } from "../src/checkpoints/store.js";
import { claim } from "./helpers.js";

class MemoryS3 {
  readonly objects = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<any> {
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      if (command.input.IfNoneMatch === "*" && this.objects.has(key)) {
        throw Object.assign(new Error("exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      this.objects.set(key, new Uint8Array(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const bytes = this.objects.get(String(command.input.Key));
      if (bytes === undefined) {
        throw Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        ContentLength: bytes.length,
        Body: { transformToByteArray: async () => new Uint8Array(bytes) },
      };
    }
    if (command instanceof CopyObjectCommand) {
      const source = decodeURIComponent(String(command.input.CopySource));
      const sourceKey = source.slice(source.indexOf("/") + 1);
      const bytes = this.objects.get(sourceKey);
      if (bytes === undefined) {
        throw Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      }
      this.objects.set(String(command.input.Key), new Uint8Array(bytes));
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key));
      return {};
    }
    throw new Error("Unexpected S3 command.");
  }
}

function keyProvider(key: Uint8Array): CheckpointKeyProvider {
  return { resolve: async () => key };
}

describe("S3CheckpointStore", () => {
  it("moves one encrypted checkpoint between independent host adapters", async () => {
    const objectService = new MemoryS3();
    const sourceStore = new S3CheckpointStore(objectService as unknown as S3Client, {
      bucket: "aubtown-pilot",
    });
    const destinationStore = new S3CheckpointStore(objectService as unknown as S3Client, {
      bucket: "aubtown-pilot",
    });
    const cipher = new XChaChaCheckpointCipher(
      keyProvider(randomBytes(32)),
      () => new Uint8Array(24).fill(4),
    );
    const archive = new TextEncoder().encode("portable unpublished work");
    const encrypted = await cipher.encrypt({
      manifest: createCheckpointManifest({
        claim: claim({ hostId: "macos-executor-1" }),
        repositoryHead: "a".repeat(40),
        baseHead: "b".repeat(40),
        patch: new TextEncoder().encode("diff --git a/file b/file\n"),
        includedUntrackedPaths: [],
        validationReceipts: ["focused-test:passed"],
        createdAt: "2026-08-13T18:00:00.000Z",
      }),
      archive,
      keyReference: "keyring:checkpoint-v1",
    });
    const reference = await sourceStore.put(encrypted);
    await expect(sourceStore.put(encrypted)).resolves.toBe(reference);
    const restored = await destinationStore.get(reference);
    expect(restored?.manifest.sourceHostId).toBe("macos-executor-1");
    await expect(cipher.decrypt(restored!)).resolves.toEqual(archive);
    await sourceStore.retire(reference, "2026-08-14T18:00:00.000Z");
    await expect(destinationStore.get(reference)).resolves.toBeUndefined();
    expect([...objectService.objects.keys()].some((key) => key.includes("/retired/"))).toBe(true);
  });

  it("rejects an object whose bytes do not match its content address", async () => {
    const objectService = new MemoryS3();
    const store = new S3CheckpointStore(objectService as unknown as S3Client, {
      bucket: "aubtown-pilot",
    });
    const reference = "a".repeat(64);
    objectService.objects.set(
      `aubtown/checkpoints/active/${reference}.checkpoint`,
      new TextEncoder().encode("wrong bytes"),
    );
    await expect(store.get(reference)).rejects.toThrow("digest");
  });
});
