import { readFile } from "node:fs/promises";
import { loadHostPrivateKey } from "../security/host-enrollment.js";
import { signHostEnvelope, type UnsignedHostEnvelope } from "../security/host-envelope.js";

const [privateKeyFile, envelopeFile] = process.argv.slice(2);
if (privateKeyFile === undefined || envelopeFile === undefined) {
  throw new Error("Usage: sign-host-envelope <private-key-file> <unsigned-envelope-json>");
}
if (!envelopeFile.startsWith("/")) {
  throw new Error("Unsigned envelope path must be absolute.");
}
const privateKey = await loadHostPrivateKey(privateKeyFile);
const envelope = JSON.parse(await readFile(envelopeFile, "utf8")) as UnsignedHostEnvelope;
process.stdout.write(`${JSON.stringify(signHostEnvelope(envelope, privateKey))}\n`);
