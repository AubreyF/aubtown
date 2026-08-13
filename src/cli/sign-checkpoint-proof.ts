import { readFile } from "node:fs/promises";
import { signCheckpointProof, type UnsignedCheckpointProof } from "../checkpoints/proof.js";
import { loadHostPrivateKey } from "../security/host-enrollment.js";

const [privateKeyFile, proofFile] = process.argv.slice(2);
if (privateKeyFile === undefined || proofFile === undefined) {
  throw new Error("Usage: sign-checkpoint-proof <private-key-file> <unsigned-proof-json>");
}
if (!proofFile.startsWith("/")) {
  throw new Error("Unsigned checkpoint proof path must be absolute.");
}
const privateKey = await loadHostPrivateKey(privateKeyFile);
const proof = JSON.parse(await readFile(proofFile, "utf8")) as UnsignedCheckpointProof;
process.stdout.write(`${JSON.stringify(signCheckpointProof(proof, privateKey))}\n`);
