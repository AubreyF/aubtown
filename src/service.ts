import * as restate from "@restatedev/restate-sdk";
import { createServer } from "node:http2";
import { integrationHarnessEnabled } from "./config/integration-harness.js";
import { controlPlaneServices } from "./orchestration/control-plane-services.js";
import { createHostGateway } from "./orchestration/host-gateway.js";
import {
  loadHostEnrollments,
  loadPrivateKeyPem,
  loadPublicKeyPem,
} from "./security/host-enrollment.js";
import { CheckpointGrantIssuer } from "./checkpoints/grant.js";
import { loadExecutionAccountProfiles } from "./config/account-profiles.js";
import { createRoutePlanner } from "./orchestration/route-planner.js";
import { parseBindHost, parseServicePort } from "./config/network.js";

const identityKeys = (process.env.AUBTOWN_RESTATE_IDENTITY_KEYS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const hostEnrollments = await loadHostEnrollments(process.env);
const accountProfiles = await loadExecutionAccountProfiles(
  process.env,
  hostEnrollments,
);
const checkpointGrantKeyFile = process.env.AUBTOWN_CHECKPOINT_GRANT_PRIVATE_KEY_FILE?.trim();
const checkpointGrantIssuer =
  checkpointGrantKeyFile === undefined || checkpointGrantKeyFile.length === 0
    ? undefined
    : new CheckpointGrantIssuer(
        await loadPrivateKeyPem(checkpointGrantKeyFile, "Checkpoint grant private key"),
      );
const checkpointReceiptKeyFile =
  process.env.AUBTOWN_CHECKPOINT_RECEIPT_PUBLIC_KEY_FILE?.trim();
const checkpointReceiptPublicKeyPem =
  checkpointReceiptKeyFile === undefined || checkpointReceiptKeyFile.length === 0
    ? undefined
    : await loadPublicKeyPem(
        checkpointReceiptKeyFile,
        "Checkpoint receipt public key",
      );
const hostGateway = createHostGateway(
  hostEnrollments,
  checkpointGrantIssuer,
  checkpointReceiptPublicKeyPem,
);
const enableIntegrationHarness = integrationHarnessEnabled(
  process.env.AUBTOWN_ENABLE_INTEGRATION_HARNESS,
);
const routePlanner = createRoutePlanner(hostEnrollments, accountProfiles);

const port = parseServicePort(process.env.PORT, 9_080);
const bindHost = parseBindHost(process.env.AUBTOWN_BIND_HOST);
const server = createServer(
  restate.createEndpointHandler({
    services: controlPlaneServices(
      hostGateway,
      enableIntegrationHarness,
      routePlanner,
    ),
    ...(identityKeys.length === 0 ? {} : { identityKeys }),
  }),
);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, bindHost, () => {
    server.off("error", reject);
    resolve();
  });
});

process.stdout.write(
  `AubTown Restate endpoint listening on ${bindHost}:${port.toLocaleString()}.\n`,
);

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
