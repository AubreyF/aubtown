import { describe, expect, it } from "vitest";
import { integrationHarnessEnabled } from "../src/config/integration-harness.js";
import { accountGovernor } from "../src/orchestration/account-governor.js";
import { claimRegistry } from "../src/orchestration/claim-registry.js";
import { checkpointCatalog } from "../src/orchestration/checkpoint-catalog.js";
import { controlPlaneServices } from "../src/orchestration/control-plane-services.js";
import { custodyTransferWorkflow } from "../src/orchestration/custody-transfer-workflow.js";
import { dryRunWorkflow } from "../src/orchestration/dry-run-workflow.js";
import { fakeWorker } from "../src/orchestration/fake-worker.js";
import { executorCommandRegistry } from "../src/orchestration/executor-command-registry.js";
import { hostRegistry } from "../src/orchestration/host-registry.js";
import { hostRestoreRegistry } from "../src/orchestration/host-restore-registry.js";
import { createHostGateway } from "../src/orchestration/host-gateway.js";
import { qualificationWorkflow } from "../src/orchestration/qualification-workflow.js";
import { reconciliationWorkflow } from "../src/orchestration/reconciliation-workflow.js";
import { schedulerRegistry } from "../src/orchestration/scheduler-registry.js";

describe("Restate ingress boundary", () => {
  it("keeps every durable internal service private to Restate calls", () => {
    const internalServices = [
      accountGovernor,
      checkpointCatalog,
      claimRegistry,
      custodyTransferWorkflow,
      dryRunWorkflow,
      fakeWorker,
      executorCommandRegistry,
      hostRegistry,
      hostRestoreRegistry,
      qualificationWorkflow,
      reconciliationWorkflow,
      schedulerRegistry,
    ];

    for (const service of internalServices) {
      const definition = service as unknown as {
        readonly name: string;
        readonly options?: { readonly ingressPrivate?: boolean };
      };
      expect(definition.options?.ingressPrivate, definition.name).toBe(true);
    }
  });

  it("requires an exact opt-in before binding the local integration harness", () => {
    expect(integrationHarnessEnabled(undefined)).toBe(false);
    expect(integrationHarnessEnabled("")).toBe(false);
    expect(integrationHarnessEnabled("false")).toBe(false);
    expect(integrationHarnessEnabled("true")).toBe(true);
    expect(() => integrationHarnessEnabled("TRUE")).toThrow(
      "must be exactly true or false",
    );
    expect(() => integrationHarnessEnabled("1")).toThrow(
      "must be exactly true or false",
    );
  });

  it("exposes only HostGateway in the production service manifest", () => {
    const definitions = controlPlaneServices(createHostGateway({}), false).map(
      (service) =>
        service as unknown as {
          readonly name: string;
          readonly options?: { readonly ingressPrivate?: boolean };
        },
    );
    const publicNames = definitions
      .filter((service) => service.options?.ingressPrivate !== true)
      .map((service) => service.name);

    expect(publicNames).toEqual(["HostGateway"]);
    expect(definitions.map((service) => service.name)).not.toContain(
      "IntegrationHarness",
    );
    expect(
      controlPlaneServices(createHostGateway({}), true).map(
        (service) => service.name,
      ),
    ).toContain("IntegrationHarness");
  });
});
