import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../security/canonical-json.js";
import {
  checkpointManifestSchema,
  MAX_STORED_CHECKPOINT_BYTES,
} from "./codec.js";

const unsignedCheckpointStorageReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  reference: z.string().regex(/^[0-9a-f]{64}$/u),
  contentLength: z.number().int().positive().max(MAX_STORED_CHECKPOINT_BYTES),
  hostId: z.string().min(1),
  grantNonce: z.uuid(),
  manifest: checkpointManifestSchema,
  storedAt: z.iso.datetime(),
});

export type UnsignedCheckpointStorageReceipt = z.infer<
  typeof unsignedCheckpointStorageReceiptSchema
>;

export type SignedCheckpointStorageReceipt = UnsignedCheckpointStorageReceipt & {
  readonly signatureBase64: string;
};

export const signedCheckpointStorageReceiptSchema = z.intersection(
  unsignedCheckpointStorageReceiptSchema,
  z.object({ signatureBase64: z.string().min(1) }),
);

function assertEd25519(key: KeyObject, purpose: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${purpose} must be an Ed25519 key.`);
  }
  return key;
}

function unsigned(
  receipt: SignedCheckpointStorageReceipt,
): UnsignedCheckpointStorageReceipt {
  const { signatureBase64: _signature, ...body } = receipt;
  return unsignedCheckpointStorageReceiptSchema.parse(body);
}

export class CheckpointStorageReceiptIssuer {
  readonly #privateKey: KeyObject;

  constructor(privateKeyPem: string) {
    this.#privateKey = assertEd25519(
      createPrivateKey(privateKeyPem),
      "Checkpoint receipt private key",
    );
  }

  issue(
    input: UnsignedCheckpointStorageReceipt,
  ): SignedCheckpointStorageReceipt {
    const receipt = unsignedCheckpointStorageReceiptSchema.parse(input);
    return {
      ...receipt,
      signatureBase64: sign(null, canonicalJson(receipt), this.#privateKey).toString(
        "base64",
      ),
    };
  }
}

export function parseSignedCheckpointStorageReceipt(
  value: unknown,
): SignedCheckpointStorageReceipt {
  return signedCheckpointStorageReceiptSchema.parse(
    value,
  ) as SignedCheckpointStorageReceipt;
}

export function verifyCheckpointStorageReceipt(input: {
  readonly receipt: SignedCheckpointStorageReceipt;
  readonly publicKeyPem: string;
}): SignedCheckpointStorageReceipt {
  const receipt = parseSignedCheckpointStorageReceipt(input.receipt);
  const key = assertEd25519(
    createPublicKey(input.publicKeyPem),
    "Checkpoint receipt public key",
  );
  if (
    !verify(
      null,
      canonicalJson(unsigned(receipt)),
      key,
      Buffer.from(receipt.signatureBase64, "base64"),
    )
  ) {
    throw new Error("Checkpoint storage receipt signature is invalid.");
  }
  return receipt;
}
