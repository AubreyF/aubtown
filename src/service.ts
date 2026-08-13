import * as restate from "@restatedev/restate-sdk";
import { integrationHarnessEnabled } from "./config/integration-harness.js";
import { controlPlaneServices } from "./orchestration/control-plane-services.js";
import { createHostGateway } from "./orchestration/host-gateway.js";
import { loadHostEnrollments, loadPrivateKeyPem } from "./security/host-enrollment.js";
import { CheckpointGrantIssuer } from "./checkpoints/grant.js";

const identityKeys = (process.env.FREEDWORKS_RESTATE_IDENTITY_KEYS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const hostEnrollments = await loadHostEnrollments(process.env);
const checkpointGrantKeyFile = process.env.FREEDWORKS_CHECKPOINT_GRANT_PRIVATE_KEY_FILE?.trim();
const checkpointGrantIssuer =
  checkpointGrantKeyFile === undefined || checkpointGrantKeyFile.length === 0
    ? undefined
    : new CheckpointGrantIssuer(
        await loadPrivateKeyPem(checkpointGrantKeyFile, "Checkpoint grant private key"),
      );
const hostGateway = createHostGateway(hostEnrollments, checkpointGrantIssuer);
const enableIntegrationHarness = integrationHarnessEnabled(
  process.env.FREEDWORKS_ENABLE_INTEGRATION_HARNESS,
);

const port = await restate.serve({
  services: controlPlaneServices(hostGateway, enableIntegrationHarness),
  ...(identityKeys.length === 0 ? {} : { identityKeys }),
});

process.stdout.write(`Freedworks Restate endpoint listening on ${port.toLocaleString()}.\n`);
