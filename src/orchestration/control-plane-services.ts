import type { ServeOptions } from "@restatedev/restate-sdk";
import { accountGovernor } from "./account-governor.js";
import { claimRegistry } from "./claim-registry.js";
import { custodyTransferWorkflow } from "./custody-transfer-workflow.js";
import { dryRunWorkflow } from "./dry-run-workflow.js";
import { fakeWorker } from "./fake-worker.js";
import { executorCommandRegistry } from "./executor-command-registry.js";
import { checkpointCatalog } from "./checkpoint-catalog.js";
import { hostRegistry } from "./host-registry.js";
import { hostRestoreRegistry } from "./host-restore-registry.js";
import { hostWorkspaceRegistry } from "./host-workspace-registry.js";
import { createHostGateway } from "./host-gateway.js";
import { integrationHarness } from "./integration-harness.js";
import { qualificationWorkflow } from "./qualification-workflow.js";
import { reconciliationWorkflow } from "./reconciliation-workflow.js";
import { schedulerRegistry } from "./scheduler-registry.js";
import { createRoutePlanner, routePlannerApi } from "./route-planner.js";
import { admittedDispatchWorkflow } from "./admitted-dispatch-workflow.js";

export function controlPlaneServices(
  hostGateway: ReturnType<typeof createHostGateway>,
  enableIntegrationHarness: boolean,
  routePlanner: ReturnType<typeof createRoutePlanner> = routePlannerApi,
): ServeOptions["services"] {
  return [
    accountGovernor,
    admittedDispatchWorkflow,
    claimRegistry,
    dryRunWorkflow,
    fakeWorker,
    executorCommandRegistry,
    checkpointCatalog,
    qualificationWorkflow,
    schedulerRegistry,
    hostRegistry,
    hostRestoreRegistry,
    hostWorkspaceRegistry,
    custodyTransferWorkflow,
    reconciliationWorkflow,
    routePlanner,
    hostGateway,
    ...(enableIntegrationHarness ? [integrationHarness] : []),
  ];
}
