import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import type { CommandRunner } from "../command-runner.js";
import { canonicalJsonEqual } from "../../security/canonical-json.js";
import {
  FreedClaimBrokerClient,
  type FreedBrokerClaim,
  type FreedClaimAcquireRequest,
  type FreedClaimHeartbeatRequest,
  type FreedClaimReleaseRequest,
  type FreedClaimTransferRequest,
} from "./claim-broker.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const uuidSchema = z.uuid();

const acquireSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: uuidSchema,
  taskId: z.string().min(1),
  expectedTaskRevision: z.number().int().positive(),
  bindingDigest: digestSchema,
  claim: z.object({
    claimId: z.string().min(1),
    githubIssue: z.object({
      number: z.number().int().positive(),
      url: z.url(),
    }).strict(),
    custodyEpoch: z.number().int().positive(),
    hostId: z.string().min(1),
    workerId: z.string().min(1),
    branch: z.string().min(1),
    worktree: z.string().min(1),
    conflictDomains: z.array(z.string().min(1)),
    conflictDomainDigest: digestSchema,
    claimedAt: z.iso.datetime(),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
    accountId: z.string().min(1),
    driverId: z.string().min(1),
    target: z.enum(["shared", "desktop", "pwa", "website"]),
    workLane: z.enum([
      "runtime-neutral",
      "behavioral",
      "provider-visible",
      "integration",
      "release",
      "macos",
      "sensitive",
    ]),
    publicationCeiling: z.literal("draft-pr"),
  }).strict(),
  requestedAt: z.iso.datetime(),
}).strict();

const conformanceInputSchema = z.object({
  schemaVersion: z.literal(1),
  broker: z.object({
    executable: z.string().refine(path.isAbsolute, "must be absolute"),
    cwd: z.string().refine(path.isAbsolute, "must be absolute"),
    profile: z.string().regex(/^conformance-[a-z0-9][a-z0-9-]{2,63}$/u),
  }).strict(),
  acquire: acquireSchema.omit({
    operationId: true,
    requestedAt: true,
  }).extend({
    claim: acquireSchema.shape.claim.omit({ claimedAt: true }),
  }).strict(),
  transfer: z.object({
    destinationHostId: z.string().min(1),
    destinationWorkerId: z.string().min(1),
    destinationWorktree: z.string().min(1),
    checkpointReference: digestSchema,
  }).strict(),
  release: z.object({
    reason: z.enum([
      "prelaunch-denied",
      "worker-completed",
      "worker-failed",
      "worker-interrupted",
      "reconciled-unlaunched",
    ]),
  }).strict(),
}).strict();

export type FreedBrokerConformanceInput = z.infer<typeof conformanceInputSchema>;

export function parseFreedBrokerConformanceInput(
  value: unknown,
): FreedBrokerConformanceInput {
  return conformanceInputSchema.parse(value);
}

export interface FreedBrokerConformanceCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface FreedBrokerConformanceReport {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly brokerExecutable: string;
  readonly brokerSha256: string;
  readonly checkedAt: string;
  readonly passed: boolean;
  readonly checks: readonly FreedBrokerConformanceCheck[];
  readonly blockers: readonly string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function brokerErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return undefined;
  }
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string") {
    return undefined;
  }
  for (const line of stderr.trim().split("\n").reverse()) {
    try {
      const parsed = z.object({
        schemaVersion: z.literal(1),
        error: z.object({ code: z.string().min(1) }).passthrough(),
      }).passthrough().parse(JSON.parse(line));
      return parsed.error.code;
    } catch {
      continue;
    }
  }
  return undefined;
}

function expectedClaim(
  input: FreedBrokerConformanceInput,
  acquiredAt: string,
  overrides: Partial<FreedBrokerClaim> = {},
): FreedBrokerClaim {
  return {
    ...input.acquire.claim,
    claimedAt: acquiredAt,
    heartbeatAt: acquiredAt,
    executionStage: "claimed",
    ...overrides,
  };
}

export async function runFreedBrokerConformance(input: {
  readonly runner: CommandRunner;
  readonly config: FreedBrokerConformanceInput;
  readonly checkedAt: string;
}): Promise<FreedBrokerConformanceReport> {
  const config = parseFreedBrokerConformanceInput(input.config);
  const checkedAtMs = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error("Freed broker conformance timestamp is invalid.");
  }
  const at = (millisecondsBeforeCheck: number): string =>
    new Date(checkedAtMs - millisecondsBeforeCheck).toISOString();
  const acquiredAt = at(4_000);
  const changedReplayAt = at(3_500);
  const heartbeatAt = at(3_000);
  const changedHeartbeatAt = at(2_500);
  const transferredAt = at(2_000);
  const releasedAt = at(1_000);
  const operationIds = {
    acquire: randomUUID(),
    duplicateAcquire: randomUUID(),
    heartbeat: randomUUID(),
    staleHeartbeat: randomUUID(),
    transfer: randomUUID(),
    release: randomUUID(),
  };
  const acquire: FreedClaimAcquireRequest = {
    ...config.acquire,
    operationId: operationIds.acquire,
    claim: { ...config.acquire.claim, claimedAt: acquiredAt },
    requestedAt: acquiredAt,
  };
  const checks: FreedBrokerConformanceCheck[] = [];
  let brokerSha256 = "";
  const client = new FreedClaimBrokerClient(input.runner, {
    executable: config.broker.executable,
    args: ["--profile", config.broker.profile],
    cwd: config.broker.cwd,
  });

  const pass = (id: string, detail: string): void => {
    checks.push({ id, passed: true, detail });
  };
  const fail = (id: string, detail: string): FreedBrokerConformanceReport => {
    checks.push({ id, passed: false, detail });
    return {
      schemaVersion: 1,
      profile: config.broker.profile,
      brokerExecutable: config.broker.executable,
      brokerSha256,
      checkedAt: input.checkedAt,
      passed: false,
      checks,
      blockers: [`${id}:${detail}`],
    };
  };
  const expectRejected = async (
    id: string,
    expectedCode: string,
    operation: () => Promise<unknown>,
  ): Promise<FreedBrokerConformanceReport | undefined> => {
    try {
      await operation();
      return fail(id, "broker accepted a conflicting operation");
    } catch (error) {
      const code = brokerErrorCode(error);
      if (code !== expectedCode) {
        return fail(
          id,
          `broker returned ${code ?? "an unstructured failure"}, expected ${expectedCode}`,
        );
      }
      pass(id, `broker rejected the conflicting operation with ${code}`);
      return undefined;
    }
  };

  try {
    if ((await realpath(config.broker.executable)) !== config.broker.executable) {
      throw new Error("broker executable is not one physical file");
    }
    const stats = await lstat(config.broker.executable);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 1 ||
      stats.size > 64 * 1_024 * 1_024 ||
      (stats.mode & 0o022) !== 0 ||
      (stats.mode & 0o111) === 0
    ) {
      throw new Error("broker executable has unsafe type, mode, size, or permissions");
    }
    brokerSha256 = createHash("sha256")
      .update(await readFile(config.broker.executable))
      .digest("hex");
  } catch (error) {
    return fail("broker-integrity", errorMessage(error));
  }
  pass("broker-integrity", `reviewed executable sha256:${brokerSha256}`);

  let acquireReceipt;
  try {
    acquireReceipt = await client.acquire(acquire);
  } catch (error) {
    return fail("acquire", errorMessage(error));
  }
  if (
    acquireReceipt.operationId !== acquire.operationId ||
    acquireReceipt.taskId !== acquire.taskId ||
    acquireReceipt.taskRevision !== acquire.expectedTaskRevision ||
    acquireReceipt.authorityClaimId !== acquire.claim.claimId ||
    acquireReceipt.custodyEpoch !== acquire.claim.custodyEpoch ||
    acquireReceipt.bindingDigest !== acquire.bindingDigest ||
    acquireReceipt.conflictDomainDigest !==
      acquire.claim.conflictDomainDigest
  ) {
    return fail("acquire", "receipt does not bind the exact disposable claim");
  }
  pass("acquire", "broker acquired the exact disposable claim");

  try {
    const replay = await client.acquire(acquire);
    if (!canonicalJsonEqual(replay, acquireReceipt)) {
      return fail("acquire-replay", "exact retry returned another receipt");
    }
  } catch (error) {
    return fail("acquire-replay", errorMessage(error));
  }
  pass("acquire-replay", "exact retry recovered the original receipt");

  let rejected = await expectRejected(
    "changed-operation-replay",
    "operation_replay_conflict",
    () => client.acquire({ ...acquire, requestedAt: changedReplayAt }),
  );
  if (rejected !== undefined) return rejected;

  let shown;
  try {
    shown = await client.show({ schemaVersion: 1, taskId: acquire.taskId });
  } catch (error) {
    return fail("show-after-acquire", errorMessage(error));
  }
  if (
    shown.taskId !== acquire.taskId ||
    shown.taskRevision !== acquire.expectedTaskRevision ||
    shown.bindingDigest !== acquire.bindingDigest ||
    !canonicalJsonEqual(shown.claim, expectedClaim(config, acquiredAt))
  ) {
    return fail("show-after-acquire", "broker did not project the exact claim");
  }
  pass("show-after-acquire", "claim survives a separate broker process");

  try {
    const listed = await client.list({ schemaVersion: 1 });
    if (
      listed.claims.length !== 1 ||
      listed.claims[0]?.taskId !== acquire.taskId ||
      listed.claims[0]?.taskRevision !== acquire.expectedTaskRevision ||
      listed.claims[0]?.bindingDigest !== acquire.bindingDigest ||
      !canonicalJsonEqual(listed.claims[0]?.claim, expectedClaim(config, acquiredAt))
    ) {
      return fail("list-after-acquire", "claim list did not project the exact claim");
    }
  } catch (error) {
    return fail("list-after-acquire", errorMessage(error));
  }
  pass("list-after-acquire", "claim list survives a separate broker process");

  rejected = await expectRejected(
    "duplicate-acquire",
    "claim_already_exists",
    () =>
      client.acquire({
        ...acquire,
        operationId: operationIds.duplicateAcquire,
      }),
  );
  if (rejected !== undefined) return rejected;

  const heartbeat: FreedClaimHeartbeatRequest = {
    schemaVersion: 1,
    operationId: operationIds.heartbeat,
    taskId: acquire.taskId,
    taskRevision: acquire.expectedTaskRevision,
    authorityClaimId: acquire.claim.claimId,
    custodyEpoch: acquire.claim.custodyEpoch,
    bindingDigest: acquire.bindingDigest,
    heartbeatAt,
    executionStage: "running",
  };
  try {
    const receipt = await client.heartbeat(heartbeat);
    const replay = await client.heartbeat(heartbeat);
    if (
      !canonicalJsonEqual(receipt, heartbeat) ||
      !canonicalJsonEqual(replay, receipt)
    ) {
      return fail("heartbeat-replay", "heartbeat receipt or replay changed");
    }
  } catch (error) {
    return fail("heartbeat-replay", errorMessage(error));
  }
  pass("heartbeat-replay", "heartbeat and exact retry are durable");

  rejected = await expectRejected(
    "changed-heartbeat-replay",
    "operation_replay_conflict",
    () =>
      client.heartbeat({
        ...heartbeat,
        heartbeatAt: changedHeartbeatAt,
      }),
  );
  if (rejected !== undefined) return rejected;

  const transfer: FreedClaimTransferRequest = {
    schemaVersion: 1,
    operationId: operationIds.transfer,
    taskId: acquire.taskId,
    taskRevision: acquire.expectedTaskRevision,
    authorityClaimId: acquire.claim.claimId,
    bindingDigest: acquire.bindingDigest,
    priorEpoch: acquire.claim.custodyEpoch,
    nextEpoch: acquire.claim.custodyEpoch + 1,
    ...config.transfer,
    transferredAt,
  };
  try {
    const receipt = await client.transfer(transfer);
    const replay = await client.transfer(transfer);
    if (
      !canonicalJsonEqual(receipt, transfer) ||
      !canonicalJsonEqual(replay, receipt)
    ) {
      return fail("transfer-replay", "transfer receipt or replay changed");
    }
  } catch (error) {
    return fail("transfer-replay", errorMessage(error));
  }
  pass("transfer-replay", "checkpoint-backed transfer and retry are durable");

  rejected = await expectRejected(
    "stale-epoch-fenced",
    "claim_epoch_mismatch",
    () =>
      client.heartbeat({
        ...heartbeat,
        operationId: operationIds.staleHeartbeat,
        heartbeatAt: transferredAt,
      }),
  );
  if (rejected !== undefined) return rejected;

  const transferredClaim = expectedClaim(config, acquiredAt, {
    custodyEpoch: transfer.nextEpoch,
    hostId: transfer.destinationHostId,
    workerId: transfer.destinationWorkerId,
    worktree: transfer.destinationWorktree,
    heartbeatAt: transfer.transferredAt,
    executionStage: "running",
    transferredAt: transfer.transferredAt,
    checkpointReference: transfer.checkpointReference,
  });
  try {
    shown = await client.show({ schemaVersion: 1, taskId: acquire.taskId });
  } catch (error) {
    return fail("show-after-transfer", errorMessage(error));
  }
  if (!canonicalJsonEqual(shown.claim, transferredClaim)) {
    return fail("show-after-transfer", "destination custody is not exact");
  }
  pass("show-after-transfer", "only the destination epoch remains current");

  try {
    const listed = await client.list({ schemaVersion: 1 });
    if (
      listed.claims.length !== 1 ||
      !canonicalJsonEqual(listed.claims[0]?.claim, transferredClaim)
    ) {
      return fail("list-after-transfer", "claim list did not project destination custody");
    }
  } catch (error) {
    return fail("list-after-transfer", errorMessage(error));
  }
  pass("list-after-transfer", "claim list projects only destination custody");

  const release: FreedClaimReleaseRequest = {
    schemaVersion: 1,
    operationId: operationIds.release,
    taskId: acquire.taskId,
    expectedTaskRevision: acquire.expectedTaskRevision,
    authorityClaimId: acquire.claim.claimId,
    bindingDigest: acquire.bindingDigest,
    custodyEpoch: transfer.nextEpoch,
    expectedHeartbeatAt: transfer.transferredAt,
    reason: config.release.reason,
    releasedAt,
  };
  try {
    const receipt = await client.release(release);
    const replay = await client.release(release);
    const expected = {
      ...release,
      taskRevision: release.expectedTaskRevision,
    };
    delete (expected as Partial<typeof expected>).expectedTaskRevision;
    if (
      !canonicalJsonEqual(receipt, expected) ||
      !canonicalJsonEqual(replay, receipt)
    ) {
      return fail("release-replay", "release receipt or replay changed");
    }
  } catch (error) {
    return fail("release-replay", errorMessage(error));
  }
  pass("release-replay", "exact release and retry are durable");

  try {
    shown = await client.show({ schemaVersion: 1, taskId: acquire.taskId });
  } catch (error) {
    return fail("show-after-release", errorMessage(error));
  }
  if (shown.claim !== null || shown.bindingDigest !== null) {
    return fail("show-after-release", "released claim remains dispatchable");
  }
  pass("show-after-release", "released claim is absent after restart");

  try {
    const listed = await client.list({ schemaVersion: 1 });
    if (listed.claims.length !== 0) {
      return fail("list-after-release", "released claim remains in active claim list");
    }
  } catch (error) {
    return fail("list-after-release", errorMessage(error));
  }
  pass("list-after-release", "released claim is absent from active claim list");

  return {
    schemaVersion: 1,
    profile: config.broker.profile,
    brokerExecutable: config.broker.executable,
    brokerSha256,
    checkedAt: input.checkedAt,
    passed: true,
    checks,
    blockers: [],
  };
}
