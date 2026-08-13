import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { CustodyCheckpoint } from "../domain/types.js";
import type {
  CheckpointCipher,
  CheckpointKeyProvider,
  EncryptedCheckpointPayload,
} from "./store.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 24;

function manifestAssociatedData(manifest: CustodyCheckpoint): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export class XChaChaCheckpointCipher implements CheckpointCipher {
  constructor(
    private readonly keys: CheckpointKeyProvider,
    private readonly nonceSource: (size: number) => Uint8Array = randomBytes,
  ) {}

  async encrypt(input: {
    readonly manifest: CustodyCheckpoint;
    readonly archive: Uint8Array;
    readonly keyReference: string;
  }): Promise<EncryptedCheckpointPayload> {
    const key = await this.#key(input.keyReference);
    const nonce = this.nonceSource(NONCE_BYTES);
    if (nonce.length !== NONCE_BYTES) {
      throw new Error("Checkpoint nonce source must return exactly 24 bytes.");
    }
    const cipher = xchacha20poly1305(
      key,
      nonce,
      manifestAssociatedData(input.manifest),
    );
    return {
      manifest: input.manifest,
      ciphertext: cipher.encrypt(input.archive),
      nonce,
      algorithm: "xchacha20-poly1305",
      keyReference: input.keyReference,
    };
  }

  async decrypt(payload: EncryptedCheckpointPayload): Promise<Uint8Array> {
    if (payload.algorithm !== "xchacha20-poly1305") {
      throw new Error(`Unsupported checkpoint cipher ${payload.algorithm}.`);
    }
    if (payload.nonce.length !== NONCE_BYTES) {
      throw new Error("Checkpoint nonce must contain exactly 24 bytes.");
    }
    const key = await this.#key(payload.keyReference);
    const cipher = xchacha20poly1305(
      key,
      payload.nonce,
      manifestAssociatedData(payload.manifest),
    );
    return cipher.decrypt(payload.ciphertext);
  }

  async #key(reference: string): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(reference)) {
      throw new Error("Checkpoint key reference is invalid.");
    }
    const key = await this.keys.resolve(reference);
    if (key.length !== KEY_BYTES) {
      throw new Error("Checkpoint encryption keys must contain exactly 32 bytes.");
    }
    return key;
  }
}
