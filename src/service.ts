import * as restate from "@restatedev/restate-sdk";
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

const identityKeys = (process.env.FREEDWORKS_RESTATE_IDENTITY_KEYS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const hostEnrollments = await loadHostEnrollments(process.env);
const accountProfiles = await loadExecutionAccountProfiles(
  process.env,
  hostEnrollments,
);
const checkpointGrantKeyFile = process.env.FREEDWORKS_CHECKPOINT_GRANT_PRIVATE_KEY_FILE?.trim();
const checkpointGrantIssuer =
  checkpointGrantKeyFile === undefined || checkpointGrantKeyFile.length === 0
    ? undefined
    : new CheckpointGrantIssuer(
        await loadPrivateKeyPem(checkpointGrantKeyFile, "Checkpoint grant private key"),
      );
const checkpointReceiptKeyFile =
  process.env.FREEDWORKS_CHECKPOINT_RECEIPT_PUBLIC_KEY_FILE?.trim();
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
  process.env.FREEDWORKS_ENABLE_INTEGRATION_HARNESS,
);
const routePlanner = createRoutePlanner(hostEnrollments, accountProfiles);

const port = await restate.serve({
  services: controlPlaneServices(
    hostGateway,
    enableIntegrationHarness,
    routePlanner,
  ),
  ...(identityKeys.length === 0 ? {} : { identityKeys }),
});

process.stdout.write(`Freedworks Restate endpoint listening on ${port.toLocaleString()}.\n`);
