import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionAdmissionDigest,
  type ExecutionAdmissionBinding,
} from "../src/adapters/execution-admission.js";
import type { FreedClaimShowReceipt } from "../src/adapters/freed/claim-broker.js";
import type { ReviewedValidationProfile } from "../src/adjudication/validation-profile.js";
import { assertTrustedCompletionBundle } from "../src/execution/completion-bundle.js";
import {
  trustedCompletionReceiptSchema,
  trustedCompletionReference,
} from "../src/execution/completion-receipt.js";
import {
  executorHandoffManifestDigest,
  executorHandoffManifestFromRequirement,
} from "../src/execution/handoff-manifest.js";
import { SymphonyActiveTurnJournal } from "../src/integrations/symphony/active-turn-journal.js";
import type { SymphonyAdmissionEnvelope } from "../src/integrations/symphony/admission-envelope.js";
import { symphonyWorkspaceRequirementFromBinding } from "../src/integrations/symphony/prepare-admission.js";
import {
  CompletionReconciliationStore,
  SymphonyCompletionReconciler,
} from "../src/orchestration/completion-reconciler.js";
import { authorityTask, claim, issue, report, usage } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(await realpath(os.tmpdir()), "aubtown-reconcile-")),
  );
  roots.push(root);
  return root;
}

function envelope(): SymphonyAdmissionEnvelope {
  const binding: ExecutionAdmissionBinding = {
    qualification: report(),
    authorityTask: authorityTask(),
    claim: claim(),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
    target: "shared",
  };
  return {
    schemaVersion: 1,
    preparedAt: "2026-08-13T18:00:00.000Z",
    selectedHost: { id: binding.claim.hostId, lane: "linux" },
    usage: usage({ observedAt: "2026-08-13T18:00:00.000Z" }),
    binding,
    admission: {
      schemaVersion: 1,
      bridgeId: "freed-authority-v1",
      authorityClaimId: binding.claim.claimId,
      taskId: binding.authorityTask.id,
      taskRevision: binding.authorityTask.revision,
      bindingDigest: createExecutionAdmissionDigest(binding),
      authorizedAt: "2026-08-13T18:00:00.000Z",
      expiresAt: "2026-08-13T18:05:00.000Z",
    },
  };
}

function completion(prepared: SymphonyAdmissionEnvelope) {
  const manifest = executorHandoffManifestFromRequirement(
    symphonyWorkspaceRequirementFromBinding({
      binding: prepared.binding,
      requiredAt: prepared.preparedAt,
    }),
  );
  const manifestDigest = executorHandoffManifestDigest(manifest);
  const binding = manifest.binding;
  const receipt = trustedCompletionReceiptSchema.parse({
    schemaVersion: 1,
    kind: "trusted-candidate-finalized",
    manifestDigest,
    repository: binding.repository,
    issueNumber: binding.issueNumber,
    claimId: binding.claimId,
    custodyEpoch: binding.custodyEpoch,
    hostId: binding.hostId,
    workerId: binding.workerId,
    worktree: binding.worktree,
    branch: binding.branch,
    authorityTaskId: binding.handoff.authorityTaskId,
    accountId: binding.handoff.accountId,
    driverId: binding.handoff.driverId,
    baseHead: binding.baseHead,
    head: "b".repeat(40),
    patchDigest: "d".repeat(64),
    finalizationNonce: binding.handoff.finalizationNonce,
    completedAt: "2026-08-13T18:10:00.000Z",
  });
  return assertTrustedCompletionBundle({
    schemaVersion: 1,
    kind: "trusted-completion-bundle",
    manifestDigest,
    completionReference: trustedCompletionReference(receipt),
    manifest,
    receipt,
  });
}

function currentClaim(
  prepared: SymphonyAdmissionEnvelope,
): FreedClaimShowReceipt {
  const binding = prepared.binding;
  return {
    schemaVersion: 1,
    taskId: binding.authorityTask.id,
    taskRevision: binding.authorityTask.revision,
    bindingDigest: prepared.admission.bindingDigest,
    claim: {
      claimId: binding.claim.claimId,
      githubIssue: binding.authorityTask.githubIssue,
      custodyEpoch: binding.claim.custodyEpoch,
      hostId: binding.claim.hostId,
      workerId: binding.claim.workerId,
      branch: binding.claim.branch,
      worktree: binding.claim.worktree,
      conflictDomains: [...binding.claim.conflictDomains],
      conflictDomainDigest: "e".repeat(64),
      claimedAt: binding.claim.claimedAt,
      heartbeatAt: "2026-08-13T18:09:55.000Z",
      baseHead: binding.baseHead,
      accountId: binding.accountId,
      driverId: binding.driverId,
      target: binding.target,
      workLane: binding.qualification.workLane,
      publicationCeiling: "draft-pr",
      executionStage: "running",
    },
  };
}

function validationProfile(): ReviewedValidationProfile {
  return {
    schemaVersion: 1,
    repository: report().repository,
    requirements: [
      {
        text: "Run the focused tooling test.",
        command: {
          executable: "/usr/bin/true",
          args: [],
          timeoutMs: 60_000,
        },
      },
    ],
  };
}

async function readyFixture(
  implementationObservedAt = "2026-08-13T18:09:50.000Z",
) {
  const root = await temporaryRoot();
  const prepared = envelope();
  const bundle = completion(prepared);
  const activeTurns = new SymphonyActiveTurnJournal(path.join(root, "turns"));
  await activeTurns.record({
    schemaVersion: 1,
    kind: "symphony-active-turn",
    manifestDigest: bundle.manifestDigest,
    repository: prepared.binding.qualification.repository,
    issueNumber: prepared.binding.qualification.issue.number,
    claimId: prepared.binding.claim.claimId,
    custodyEpoch: 1,
    hostId: prepared.binding.claim.hostId,
    workerId: prepared.binding.claim.workerId,
    accountId: prepared.binding.accountId,
    driverId: prepared.binding.driverId,
    threadId: "implementation-thread",
    turnId: "implementation-turn",
    observedAt: implementationObservedAt,
  });
  return { root, prepared, bundle, activeTurns };
}

describe("Symphony completion reconciliation", () => {
  it("accepts a bounded trusted-finalization retry", async () => {
    const fixture = await readyFixture("2026-08-13T18:05:01.000Z");
    const result = await new SymphonyCompletionReconciler(
      { read: async () => fixture.bundle },
      {
        inspect: async () => ({
          active: true,
          reason: "matching-active-task",
          task: fixture.prepared.binding.authorityTask,
        }),
      },
      { show: async () => currentClaim(fixture.prepared) },
      fixture.activeTurns,
    ).reconcile({
      envelope: fixture.prepared,
      currentIssue: issue(),
      usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
      validationProfile: validationProfile(),
      now: "2026-08-13T18:10:05.000Z",
    });
    expect(result?.command.workProduct.implementation).toEqual({
      driverId: "codex-app-server-v1",
      threadId: "implementation-thread",
      turnId: "implementation-turn",
    });
  });

  it("rejects a finalization retry outside the bounded freshness window", async () => {
    const fixture = await readyFixture("2026-08-13T18:04:59.000Z");
    const reconciliation = new SymphonyCompletionReconciler(
      { read: async () => fixture.bundle },
      {
        inspect: async () => ({
          active: true,
          reason: "matching-active-task",
          task: fixture.prepared.binding.authorityTask,
        }),
      },
      { show: async () => currentClaim(fixture.prepared) },
      fixture.activeTurns,
    ).reconcile({
      envelope: fixture.prepared,
      currentIssue: issue(),
      usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
      validationProfile: validationProfile(),
      now: "2026-08-13T18:10:05.000Z",
    });
    await expect(reconciliation).rejects.toThrow("not temporally adjacent");
  });

  it("rechecks live authority and emits one restart-stable adjudication command", async () => {
    const fixture = await readyFixture();
    const reconciler = new SymphonyCompletionReconciler(
      { read: async () => fixture.bundle },
      {
        inspect: async () => ({
          active: true,
          reason: "matching-active-task",
          task: fixture.prepared.binding.authorityTask,
        }),
      },
      { show: async () => currentClaim(fixture.prepared) },
      fixture.activeTurns,
    );
    const first = await reconciler.reconcile({
      envelope: fixture.prepared,
      currentIssue: issue(),
      usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
      validationProfile: validationProfile(),
      now: "2026-08-13T18:10:05.000Z",
    });
    const second = await reconciler.reconcile({
      envelope: fixture.prepared,
      currentIssue: issue(),
      usage: usage({ observedAt: "2026-08-13T18:11:00.000Z" }),
      validationProfile: validationProfile(),
      now: "2026-08-13T18:11:05.000Z",
    });
    expect(first).not.toBeNull();
    expect(second?.command.commandId).toBe(first?.command.commandId);
    expect(first).toMatchObject({
      kind: "completion-reconciled",
      manifestDigest: fixture.bundle.manifestDigest,
      completionReference: fixture.bundle.completionReference,
      authorityClaimId: fixture.prepared.binding.claim.claimId,
      command: {
        action: "adjudicate",
        accountId: "codex-pro-1",
        workProduct: {
          checkpointReference: fixture.bundle.completionReference,
          head: fixture.bundle.receipt.head,
          patchDigest: fixture.bundle.receipt.patchDigest,
          implementation: { threadId: "implementation-thread" },
        },
        validationCommands: [
          { executable: "/usr/bin/true", args: [], timeoutMs: 60_000 },
        ],
      },
    });
    const store = new CompletionReconciliationStore(
      path.join(fixture.root, "reconciliations"),
    );
    const published = await store.publish(first!);
    await expect(store.publish(second!)).resolves.toEqual(published);
  });

  it("returns pending without touching authority when no completion exists, even when quota is closed", async () => {
    const fixture = await readyFixture();
    let inspected = false;
    const result = await new SymphonyCompletionReconciler(
      { read: async () => null },
      {
        inspect: async () => {
          inspected = true;
          throw new Error("must not inspect");
        },
      },
      { show: async () => { throw new Error("must not show"); } },
      fixture.activeTurns,
    ).reconcile({
      envelope: fixture.prepared,
      currentIssue: issue(),
      usage: usage({
        observedAt: "2026-08-13T18:10:00.000Z",
        dailyConsumption: {
          day: "2026-08-13",
          baselineLifetimeTokens: 1_000_000,
          observedLifetimeTokens: 1_300_000,
          grossUsedPercent: 30,
          meterState: "coherent",
        },
      }),
      validationProfile: validationProfile(),
      now: "2026-08-13T18:10:05.000Z",
    });
    expect(result).toBeNull();
    expect(inspected).toBe(false);
  });

  it("blocks a real completion when quota is closed without touching authority", async () => {
    const fixture = await readyFixture();
    let inspected = false;
    await expect(
      new SymphonyCompletionReconciler(
        { read: async () => fixture.bundle },
        {
          inspect: async () => {
            inspected = true;
            throw new Error("must not inspect");
          },
        },
        { show: async () => { throw new Error("must not show"); } },
        fixture.activeTurns,
      ).reconcile({
        envelope: fixture.prepared,
        currentIssue: issue(),
        usage: usage({
          observedAt: "2026-08-13T18:10:00.000Z",
          dailyConsumption: {
            day: "2026-08-13",
            baselineLifetimeTokens: 1_000_000,
            observedLifetimeTokens: 1_300_000,
            grossUsedPercent: 30,
            meterState: "coherent",
          },
        }),
        validationProfile: validationProfile(),
        now: "2026-08-13T18:10:05.000Z",
      }),
    ).rejects.toThrow("Completion adjudication is blocked by quota");
    expect(inspected).toBe(false);
  });

  it("blocks stale GitHub or Freed claim state", async () => {
    const fixture = await readyFixture();
    const staleClaim = currentClaim(fixture.prepared);
    staleClaim.claim!.custodyEpoch = 2;
    const reconciler = new SymphonyCompletionReconciler(
      { read: async () => fixture.bundle },
      {
        inspect: async () => ({
          active: true,
          reason: "matching-active-task",
          task: fixture.prepared.binding.authorityTask,
        }),
      },
      { show: async () => staleClaim },
      fixture.activeTurns,
    );
    await expect(
      reconciler.reconcile({
        envelope: fixture.prepared,
        currentIssue: issue(),
        usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
        validationProfile: validationProfile(),
        now: "2026-08-13T18:10:05.000Z",
      }),
    ).rejects.toThrow("execution claim changed");
    await expect(
      reconciler.reconcile({
        envelope: fixture.prepared,
        currentIssue: issue({ state: "closed" }),
        usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
        validationProfile: validationProfile(),
        now: "2026-08-13T18:10:05.000Z",
      }),
    ).rejects.toThrow("no longer eligible");
  });

  it("blocks validation text outside the reviewed command catalog", async () => {
    const fixture = await readyFixture();
    await expect(
      new SymphonyCompletionReconciler(
        { read: async () => fixture.bundle },
        {
          inspect: async () => ({
            active: true,
            reason: "matching-active-task",
            task: fixture.prepared.binding.authorityTask,
          }),
        },
        { show: async () => currentClaim(fixture.prepared) },
        fixture.activeTurns,
      ).reconcile({
        envelope: fixture.prepared,
        currentIssue: issue(),
        usage: usage({ observedAt: "2026-08-13T18:10:00.000Z" }),
        validationProfile: {
          ...validationProfile(),
          requirements: [
            {
              text: "Another command.",
              command: {
                executable: "/usr/bin/true",
                args: [],
                timeoutMs: 60_000,
              },
            },
          ],
        },
        now: "2026-08-13T18:10:05.000Z",
      }),
    ).rejects.toThrow("not in the reviewed command catalog");
  });
});
