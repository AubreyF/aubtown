import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { TrustedCompletionBundleStore } from "../execution/completion-bundle.js";

const configFile = process.argv[2];
const manifestDigest = process.argv[3];
if (configFile === undefined || manifestDigest === undefined) {
  throw new Error(
    "Provide the absolute worker runtime config path and manifest digest.",
  );
}
const runtime = await loadWorkerRuntimeConfig(configFile);
const bundle = await new TrustedCompletionBundleStore(runtime.handoffRoot).load(
  manifestDigest,
);
process.stdout.write(
  `${JSON.stringify(
    bundle === null
      ? { schemaVersion: 1, status: "pending", manifestDigest }
      : { schemaVersion: 1, status: "completed", bundle },
  )}\n`,
);
