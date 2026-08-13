import type { ServeOptions } from "@restatedev/restate-sdk";
import { accountGovernor } from "./account-governor.js";
import { claimRegistry } from "./claim-registry.js";
import { custodyTransferWorkflow } from "./custody-transfer-workflow.js";
import { dryRunWorkflow } from "./dry-run-workflow.js";
import { fakeWorker } from "./fake-worker.js";
import { executorCommandRegistry } from "./executor-command-registry.js";
import { hostRegistry } from "./host-registry.js";
import { createHostGateway } from "./host-gateway.js";
import { integrationHarness } from "./integration-harness.js";
import { qualificationWorkflow } from "./qualification-workflow.js";
import { reconciliationWorkflow } from "./reconciliation-workflow.js";
import { schedulerRegistry } from "./scheduler-registry.js";

export function controlPlaneServices(
  hostGateway: ReturnType<typeof createHostGateway>,
  enableIntegrationHarness: boolean,
): ServeOptions["services"] {
  return [
    accountGovernor,
    claimRegistry,
    dryRunWorkflow,
    fakeWorker,
    executorCommandRegistry,
    qualificationWorkflow,
    schedulerRegistry,
    hostRegistry,
    custodyTransferWorkflow,
    reconciliationWorkflow,
    hostGateway,
    ...(enableIntegrationHarness ? [integrationHarness] : []),
  ];
}
