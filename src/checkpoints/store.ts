import type { CustodyCheckpoint } from "../domain/types.js";

export interface EncryptedCheckpointPayload {
  readonly manifest: CustodyCheckpoint;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly algorithm: "xchacha20-poly1305";
  readonly keyReference: string;
}

export interface CheckpointStore {
  put(payload: EncryptedCheckpointPayload): Promise<string>;
  get(reference: string): Promise<EncryptedCheckpointPayload | undefined>;
  retire(reference: string, retiredAt: string): Promise<void>;
}

export interface CheckpointCipher {
  encrypt(input: {
    readonly manifest: CustodyCheckpoint;
    readonly archive: Uint8Array;
    readonly keyReference: string;
  }): Promise<EncryptedCheckpointPayload>;
  decrypt(payload: EncryptedCheckpointPayload): Promise<Uint8Array>;
}

export interface CheckpointKeyProvider {
  resolve(keyReference: string): Promise<Uint8Array>;
}
