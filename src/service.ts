import * as restate from "@restatedev/restate-sdk";
import { accountGovernor } from "./orchestration/account-governor.js";
import { claimRegistry } from "./orchestration/claim-registry.js";
import { dryRunWorkflow } from "./orchestration/dry-run-workflow.js";
import { fakeWorker } from "./orchestration/fake-worker.js";
import { qualificationWorkflow } from "./orchestration/qualification-workflow.js";
import { schedulerRegistry } from "./orchestration/scheduler-registry.js";
import { hostRegistry } from "./orchestration/host-registry.js";
import { custodyTransferWorkflow } from "./orchestration/custody-transfer-workflow.js";
import { reconciliationWorkflow } from "./orchestration/reconciliation-workflow.js";

const identityKeys = (process.env.FREEDWORKS_RESTATE_IDENTITY_KEYS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const port = await restate.serve({
  services: [
    accountGovernor,
    claimRegistry,
    dryRunWorkflow,
    fakeWorker,
    qualificationWorkflow,
    schedulerRegistry,
    hostRegistry,
    custodyTransferWorkflow,
    reconciliationWorkflow,
  ],
  ...(identityKeys.length === 0 ? {} : { identityKeys }),
});

process.stdout.write(`Freedworks Restate endpoint listening on ${port.toLocaleString()}.\n`);
