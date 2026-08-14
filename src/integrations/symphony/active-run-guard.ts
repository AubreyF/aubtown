import { z } from "zod";
import type { HostObservationSnapshot } from "../../gateway/host-observation-journal.js";
import {
  APPROVED_QUOTA_POLICY,
  decideQuota,
  type QuotaDecision,
} from "../../policy/quota.js";
import type { HostEnrollments } from "../../security/host-enrollment.js";
import {
  symphonyAdmissionEnvelopeSchema,
  type SymphonyAdmissionEnvelope,
} from "./admission-envelope.js";

const hostPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const runtimeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const reasonPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

export interface SymphonyActiveRunGuardRequest {
  readonly schemaVersion: 1;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly workerHost: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface SymphonyActiveRunGuardResponse {
  readonly schemaVersion: 1;
  readonly decision: "continue" | "interrupt";
  readonly issueId: string;
  readonly workerHost: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly reason: string;
}

const requestSchema: z.ZodType<SymphonyActiveRunGuardRequest> = z
  .object({
    schemaVersion: z.literal(1),
    issueId: z.string().regex(/^[1-9][0-9]*$/u),
    issueIdentifier: z.string().regex(/^GH-[1-9][0-9]*$/u),
    workerHost: z.string().regex(hostPattern),
    threadId: z.string().regex(runtimeIdPattern),
    turnId: z.string().regex(runtimeIdPattern),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.issueIdentifier !== `GH-${value.issueId}`) {
      context.addIssue({
        code: "custom",
        path: ["issueIdentifier"],
        message: "GitHub issue identifier does not match the issue ID.",
      });
    }
  });

function oneArgument(args: readonly string[], name: string): string {
  const indices = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indices.length !== 1) {
    throw new Error(`${name} must appear exactly once.`);
  }
  const value = args[indices[0]! + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires one value.`);
  }
  return value;
}

export function parseSymphonyActiveRunGuardRequest(
  args: readonly string[],
): SymphonyActiveRunGuardRequest {
  const known = new Set([
    "--schema-version",
    "--issue-id",
    "--issue-identifier",
    "--worker-host",
    "--thread-id",
    "--turn-id",
  ]);
  if (args.length !== known.size * 2) {
    throw new Error("Symphony active-run guard received an incomplete argument set.");
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? "")) {
      throw new Error("Symphony active-run guard received an unknown argument.");
    }
  }
  return requestSchema.parse({
    schemaVersion: Number(oneArgument(args, "--schema-version")),
    issueId: oneArgument(args, "--issue-id"),
    issueIdentifier: oneArgument(args, "--issue-identifier"),
    workerHost: oneArgument(args, "--worker-host"),
    threadId: oneArgument(args, "--thread-id"),
    turnId: oneArgument(args, "--turn-id"),
  });
}

function response(
  request: SymphonyActiveRunGuardRequest,
  decision: SymphonyActiveRunGuardResponse["decision"],
  reason: string,
): SymphonyActiveRunGuardResponse {
  if (!reasonPattern.test(reason)) {
    throw new Error("Symphony active-run guard reason is invalid.");
  }
  return {
    schemaVersion: 1,
    decision,
    issueId: request.issueId,
    workerHost: request.workerHost,
    threadId: request.threadId,
    turnId: request.turnId,
    reason,
  };
}

export function interruptSymphonyActiveRun(
  request: SymphonyActiveRunGuardRequest,
  reason: string,
): SymphonyActiveRunGuardResponse {
  return response(request, "interrupt", reason);
}

function quotaResponse(
  request: SymphonyActiveRunGuardRequest,
  decision: QuotaDecision,
): SymphonyActiveRunGuardResponse {
  return response(
    request,
    decision.action === "interrupt" ? "interrupt" : "continue",
    `quota-${decision.reason}`,
  );
}

export function evaluateSymphonyActiveRunGuard(input: {
  readonly request: SymphonyActiveRunGuardRequest;
  readonly envelope: SymphonyAdmissionEnvelope;
  readonly observations: HostObservationSnapshot;
  readonly enrollments: HostEnrollments;
  readonly now: string;
}): SymphonyActiveRunGuardResponse {
  const envelope = symphonyAdmissionEnvelopeSchema.parse(input.envelope);
  const issue = envelope.binding.qualification.issue;
  const accountId = envelope.binding.accountId;
  if (
    input.request.issueId !== issue.number.toLocaleString("en-US", { useGrouping: false }) ||
    input.request.workerHost !== envelope.selectedHost.id ||
    envelope.binding.claim.hostId !== envelope.selectedHost.id
  ) {
    return interruptSymphonyActiveRun(input.request, "active-binding-mismatch");
  }

  const enrollment = input.enrollments[envelope.selectedHost.id];
  const host = input.observations.hosts.find(
    (candidate) => candidate.id === envelope.selectedHost.id,
  );
  if (
    enrollment === undefined ||
    !enrollment.enabled ||
    enrollment.lane !== envelope.selectedHost.lane ||
    !enrollment.accountIds.includes(accountId) ||
    host === undefined ||
    !host.online ||
    host.lane !== envelope.selectedHost.lane ||
    !host.accountIds.includes(accountId)
  ) {
    return interruptSymphonyActiveRun(input.request, "active-host-invalid");
  }

  const nowMs = Date.parse(input.now);
  const heartbeatMs = Date.parse(host.lastHeartbeatAt);
  const heartbeatAgeSeconds = (nowMs - heartbeatMs) / 1_000;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatAgeSeconds < 0 ||
    heartbeatAgeSeconds > APPROVED_QUOTA_POLICY.telemetryMaxAgeSeconds
  ) {
    return interruptSymphonyActiveRun(input.request, "active-host-stale");
  }

  const usage = input.observations.usageByAccountId[accountId];
  if (usage === undefined || usage.accountId !== accountId) {
    return interruptSymphonyActiveRun(input.request, "active-quota-missing");
  }
  try {
    return quotaResponse(
      input.request,
      decideQuota({ snapshot: usage, now: input.now }),
    );
  } catch {
    return interruptSymphonyActiveRun(input.request, "active-quota-invalid");
  }
}
