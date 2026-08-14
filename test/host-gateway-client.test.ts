import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HostGatewayClient } from "../src/clients/host-gateway.js";
import { CheckpointStorageReceiptIssuer } from "../src/checkpoints/receipt.js";
import { createCheckpointManifest } from "../src/checkpoints/manifest.js";
import { parseSignedHostEnvelope, verifyHostEnvelope } from "../src/security/host-envelope.js";
import { claim } from "./helpers.js";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("HostGatewayClient", () => {
  it("signs quota observations and uses a stable request idempotency key", async () => {
    const keys = keyPair();
    let requestedUrl = "";
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080/",
      "macos-executor-1",
      keys.privateKey,
      { next: async () => 7 },
      async (input, init) => {
        requestedUrl = String(input);
        request = init;
        return Response.json({
          kind: "quota-observation",
          hostId: "macos-executor-1",
          sequence: 7,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          decision: {
            action: "admit",
            reason: "headroom-available",
            weeklyUsedPercent: 40,
            dailyUsedPercent: 0,
            observedAt: "2026-08-13T18:00:00.000Z",
          },
        });
      },
    );
    await expect(
      client.observe({
        observation: {
          accountId: "codex-pro-1",
          observedAt: "2026-08-13T18:00:00.000Z",
          primary: {
            usedPercent: 40,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-08-18T08:00:00.000Z",
          },
          activeTurnIds: [],
        },
        now: "2026-08-13T18:00:00.000Z",
      }),
    ).resolves.toMatchObject({ action: "admit" });
    expect(requestedUrl).toContain("HostGateway/macos-executor-1/submit");
    const headers = new Headers(request?.headers);
    expect(headers.get("idempotency-key")).toMatch(/^host-macos-executor-1-7-/u);
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("signs executor polls with the enrolled account scope", async () => {
    const keys = keyPair();
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 8 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "executor-poll",
          hostId: "linux-control-1",
          sequence: 8,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          command: null,
          reason: "no-command",
        });
      },
      () => new Date("2026-08-13T18:00:00.000Z"),
    );
    await expect(client.pollExecutor("codex-pro-1")).resolves.toMatchObject({
      kind: "executor-poll",
      reason: "no-command",
    });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "executor-poll",
      payload: { accountId: "codex-pro-1" },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("signs persisted-turn reconciliation before resume", async () => {
    const keys = keyPair();
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 9 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "executor-reconcile",
          hostId: "linux-control-1",
          sequence: 9,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
          action: "resume",
          reason: "current",
        });
      },
      () => new Date("2026-08-13T18:00:00.000Z"),
    );
    await expect(
      client.reconcileExecutor({
        commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
        claimId: "claim-1234",
        custodyEpoch: 1,
        accountId: "codex-pro-1",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).resolves.toMatchObject({ action: "resume", reason: "current" });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "executor-reconcile",
      payload: {
        claimId: "claim-1234",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("binds a terminal executor report to its cataloged checkpoint", async () => {
    const keys = keyPair();
    const reference = "d".repeat(64);
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 10 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "executor-receipt",
          hostId: "linux-control-1",
          sequence: 10,
          acceptedAt: "2026-08-13T18:00:00.000Z",
          commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
          stage: "completed",
          checkpointReference: reference,
        });
      },
      () => new Date("2026-08-13T18:00:00.000Z"),
    );
    await expect(
      client.reportExecutor({
        commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
        claimId: "claim-1234",
        custodyEpoch: 1,
        accountId: "codex-pro-1",
        threadId: "thread-1",
        turnId: "turn-1",
        stage: "completed",
        checkpointReference: reference,
      }),
    ).resolves.toMatchObject({ checkpointReference: reference });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "executor-receipt",
      payload: {
        stage: "completed",
        checkpointReference: reference,
      },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });

  it("submits an edge-signed checkpoint receipt through the host envelope", async () => {
    const hostKeys = keyPair();
    const receiptKeys = keyPair();
    const receipt = new CheckpointStorageReceiptIssuer(receiptKeys.privateKey).issue({
      schemaVersion: 1,
      reference: "d".repeat(64),
      contentLength: 1_024,
      hostId: "macos-executor-1",
      grantNonce: "11111111-1111-4111-8111-111111111111",
      manifest: createCheckpointManifest({
        claim: claim({ hostId: "macos-executor-1" }),
        repositoryHead: "a".repeat(40),
        baseHead: "b".repeat(40),
        patch: new TextEncoder().encode("diff --git a/a b/a\n"),
        includedUntrackedPaths: [],
        validationReceipts: [],
        createdAt: "2026-08-13T18:00:00.000Z",
      }),
      storedAt: "2026-08-13T18:00:01.000Z",
    });
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "macos-executor-1",
      hostKeys.privateKey,
      { next: async () => 10 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "checkpoint-receipt",
          hostId: "macos-executor-1",
          sequence: 10,
          acceptedAt: "2026-08-13T18:00:02.000Z",
          reference: receipt.reference,
          storedAt: receipt.storedAt,
        });
      },
      () => new Date("2026-08-13T18:00:02.000Z"),
    );

    await expect(client.submitCheckpointReceipt(receipt)).resolves.toMatchObject({
      kind: "checkpoint-receipt",
      reference: receipt.reference,
    });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "checkpoint-receipt",
      payload: { reference: receipt.reference },
    });
    expect(verifyHostEnvelope(envelope, hostKeys.publicKey)).toBe(true);
  });

  it("polls and reports a destination custody restore through signed envelopes", async () => {
    const keys = keyPair();
    const requests: RequestInit[] = [];
    let call = 0;
    const reference = "d".repeat(64);
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 11 + call },
      async (_input, init) => {
        requests.push(init ?? {});
        call += 1;
        if (call === 1) {
          return Response.json({
            kind: "restore-poll",
            hostId: "linux-control-1",
            sequence: 11,
            acceptedAt: "2026-08-13T18:00:02.000Z",
            reason: "required",
            requirement: {
              schemaVersion: 1,
              repository: {
                owner: "freed-project",
                name: "freed",
                defaultBranch: "dev",
              },
              issueNumber: 1_234,
              claimId: "claim-1234",
              priorCustodyEpoch: 1,
              custodyEpoch: 2,
              destinationHostId: "linux-control-1",
              destinationWorkerId: "worker-linux-1",
              destinationWorktree: "/srv/aubtown/worktrees/freed/1234",
              branch: "fix/deterministic-validation",
              conflictDomains: ["logical:tooling-validation"],
              claimedAt: "2026-08-13T18:00:00.000Z",
              checkpointReference: reference,
              checkpointContentLength: 1_024,
              checkpointBaseHead: "a".repeat(40),
              requiredAt: "2026-08-13T18:00:01.000Z",
            },
          });
        }
        return Response.json({
          kind: "restore-receipt",
          hostId: "linux-control-1",
          sequence: 12,
          acceptedAt: "2026-08-13T18:00:03.000Z",
          claimId: "claim-1234",
          custodyEpoch: 2,
          checkpointReference: reference,
        });
      },
      () => new Date("2026-08-13T18:00:02.000Z"),
    );

    await expect(client.pollRestore()).resolves.toMatchObject({
      reason: "required",
      requirement: { checkpointReference: reference },
    });
    await expect(
      client.reportRestore({
        schemaVersion: 1,
        claimId: "claim-1234",
        custodyEpoch: 2,
        destinationHostId: "linux-control-1",
        destinationWorktree: "/srv/aubtown/worktrees/freed/1234",
        checkpointReference: reference,
        checkpointBaseHead: "a".repeat(40),
        restoredAt: "2026-08-13T18:00:03.000Z",
      }),
    ).resolves.toMatchObject({ kind: "restore-receipt" });
    const envelopes = requests.map((request) =>
      parseSignedHostEnvelope(JSON.parse(String(request.body))),
    );
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      "restore-poll",
      "restore-receipt",
    ]);
    for (const envelope of envelopes) {
      expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
    }
  });

  it("polls and reports initial workspace preparation through signed envelopes", async () => {
    const keys = keyPair();
    const requests: RequestInit[] = [];
    let sequence = 12;
    const requirement = {
      schemaVersion: 1 as const,
      repository: {
        owner: "freed-project",
        name: "freed",
        defaultBranch: "dev",
      },
      issueNumber: 1_234,
      claimId: "claim-1234",
      custodyEpoch: 1 as const,
      hostId: "linux-control-1",
      workerId: "worker-linux-1",
      worktree: "/srv/aubtown/worktrees/freed/1234",
      branch: "fix/deterministic-validation",
      conflictDomains: ["logical:tooling-validation"],
      claimedAt: "2026-08-13T18:00:00.000Z",
      baseHead: "a".repeat(40),
      target: "shared",
      requiredAt: "2026-08-13T18:00:01.000Z",
    };
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => ++sequence },
      async (_input, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) {
          return Response.json({
            kind: "workspace-poll",
            hostId: "linux-control-1",
            sequence: 13,
            acceptedAt: "2026-08-13T18:00:02.000Z",
            requirement,
            reason: "required",
          });
        }
        return Response.json({
          kind: "workspace-receipt",
          hostId: "linux-control-1",
          sequence: 14,
          acceptedAt: "2026-08-13T18:00:03.000Z",
          claimId: requirement.claimId,
          custodyEpoch: 1,
          baseHead: requirement.baseHead,
        });
      },
      () => new Date("2026-08-13T18:00:02.000Z"),
    );

    await expect(client.pollWorkspace()).resolves.toMatchObject({
      reason: "required",
      requirement: { baseHead: requirement.baseHead },
    });
    await expect(
      client.reportWorkspace({
        schemaVersion: 1,
        claimId: requirement.claimId,
        custodyEpoch: 1,
        hostId: requirement.hostId,
        worktree: requirement.worktree,
        branch: requirement.branch,
        baseHead: requirement.baseHead,
        preparedAt: "2026-08-13T18:00:03.000Z",
      }),
    ).resolves.toMatchObject({ kind: "workspace-receipt" });
    const envelopes = requests.map((request) =>
      parseSignedHostEnvelope(JSON.parse(String(request.body))),
    );
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      "workspace-poll",
      "workspace-receipt",
    ]);
    for (const envelope of envelopes) {
      expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
    }
  });

  it("signs validation and independent-review receipts for one work product", async () => {
    const keys = keyPair();
    const requests: RequestInit[] = [];
    let sequence = 20;
    const checkpointReference = "d".repeat(64);
    const workProduct = {
      schemaVersion: 1 as const,
      repository: {
        owner: "freed-project",
        name: "freed",
        defaultBranch: "dev",
      },
      issueNumber: 1_234,
      claimId: "claim-1234",
      custodyEpoch: 1,
      hostId: "linux-control-1",
      branch: "fix/deterministic-validation",
      worktree: "/srv/aubtown/worktrees/freed/1234",
      commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
      checkpointReference,
      baseHead: "a".repeat(40),
      head: "b".repeat(40),
      patchDigest: "c".repeat(64),
      implementation: {
        driverId: "codex-app-server-v1",
        threadId: "implementation-thread",
        turnId: "implementation-turn",
      },
    };
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => ++sequence },
      async (_input, init) => {
        requests.push(init ?? {});
        return Response.json(
          requests.length === 1
            ? {
                kind: "validation-receipt",
                hostId: "linux-control-1",
                sequence: 21,
                acceptedAt: "2026-08-13T18:00:02.000Z",
                checkpointReference,
                stage: "awaiting-review",
              }
            : {
                kind: "review-receipt",
                hostId: "linux-control-1",
                sequence: 22,
                acceptedAt: "2026-08-13T18:00:03.000Z",
                checkpointReference,
                stage: "ready",
              },
        );
      },
      () => new Date("2026-08-13T18:00:01.000Z"),
    );

    await expect(
      client.reportValidation({
        schemaVersion: 1,
        kind: "exact-validation",
        workProduct,
        passed: true,
        commands: [
          {
            argv: ["/opt/node/bin/npm", "test"],
            cwd: workProduct.worktree,
            exitCode: 0,
            outputDigest: "e".repeat(64),
            durationMs: 1_000,
          },
        ],
        completedAt: "2026-08-13T18:00:02.000Z",
        summary: "Validation passed.",
      }),
    ).resolves.toMatchObject({ stage: "awaiting-review" });
    await expect(
      client.reportReview({
        schemaVersion: 1,
        kind: "independent-review",
        workProduct,
        reviewer: {
          driverId: "codex-app-server-review-v1",
          threadId: "review-thread",
          turnId: "review-turn",
        },
        verdict: "pass",
        findings: [],
        completedAt: "2026-08-13T18:00:03.000Z",
        summary: "Review passed.",
      }),
    ).resolves.toMatchObject({ stage: "ready" });
    const envelopes = requests.map((request) =>
      parseSignedHostEnvelope(JSON.parse(String(request.body))),
    );
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      "validation-receipt",
      "review-receipt",
    ]);
    for (const envelope of envelopes) {
      expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
    }
  });

  it("polls for a quota-gated adjudication action", async () => {
    const keys = keyPair();
    let request: RequestInit | undefined;
    const client = new HostGatewayClient(
      "http://127.0.0.1:8080",
      "linux-control-1",
      keys.privateKey,
      { next: async () => 23 },
      async (_input, init) => {
        request = init;
        return Response.json({
          kind: "adjudication-poll",
          hostId: "linux-control-1",
          sequence: 23,
          acceptedAt: "2026-08-13T18:00:04.000Z",
          command: null,
          action: null,
          reason: "no-command",
        });
      },
      () => new Date("2026-08-13T18:00:04.000Z"),
    );

    await expect(
      client.pollAdjudication(
        "codex-pro-1",
        "codex-app-server-review-v1",
      ),
    ).resolves.toMatchObject({ reason: "no-command" });
    const envelope = parseSignedHostEnvelope(JSON.parse(String(request?.body)));
    expect(envelope).toMatchObject({
      kind: "adjudication-poll",
      payload: {
        accountId: "codex-pro-1",
        reviewerDriverId: "codex-app-server-review-v1",
      },
    });
    expect(verifyHostEnvelope(envelope, keys.publicKey)).toBe(true);
  });
});
