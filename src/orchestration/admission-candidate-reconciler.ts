import { z } from "zod";
import type { ExecutionAdmissionBinding } from "../adapters/execution-admission.js";
import type { ExecutionAccountProfiles } from "../config/account-profiles.js";
import {
  accountUsageSnapshotSchema,
  authorityTaskSchema,
  dispatchClaimSchema,
  qualificationReportSchema,
} from "../domain/schemas.js";
import type {
  AccountUsageSnapshot,
  AuthorityTask,
  DispatchClaim,
  HostRecord,
  QualificationReport,
  WorkLane,
} from "../domain/types.js";
import { prepareSymphonyAdmissionCandidate } from "../integrations/symphony/admission-candidate.js";
import type { SymphonyAdmissionCandidate } from "../integrations/symphony/admission-envelope.js";
import {
  decideConflict,
  PILOT_CONCURRENCY_POLICY,
} from "../policy/conflicts.js";
import { planExecutionRouteFromState } from "./route-planner.js";

const HOST_HEARTBEAT_MAX_AGE_SECONDS = 120;

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const workLaneSchema = z.enum([
  "runtime-neutral",
  "behavioral",
  "provider-visible",
  "integration",
  "release",
  "macos",
  "sensitive",
]);

export interface ReconciledAdmissionCandidateInput {
  readonly qualification: QualificationReport;
  readonly authorityTask: AuthorityTask;
  readonly intendedClaim: DispatchClaim;
  readonly hosts: readonly HostRecord[];
  readonly accountProfiles: ExecutionAccountProfiles;
  readonly usageByAccountId: Readonly<
    Record<string, AccountUsageSnapshot | null>
  >;
  readonly activeClaims: readonly DispatchClaim[];
  readonly activeLanes: readonly WorkLane[];
  readonly baseHead: string;
  readonly target: "shared" | "desktop" | "pwa" | "website";
  readonly now: string;
}

export const reconciledAdmissionCandidateInputSchema: z.ZodType<ReconciledAdmissionCandidateInput> =
  z.object({
    qualification: qualificationReportSchema,
    authorityTask: authorityTaskSchema,
    intendedClaim: dispatchClaimSchema,
    hosts: z.array(
      z
        .object({
          id: identifierSchema,
          lane: z.enum(["linux", "macos"]),
          online: z.boolean(),
          lastHeartbeatAt: z.iso.datetime(),
          activeClaims: z.array(z.string().min(1)),
          accountIds: z.array(identifierSchema),
        })
        .strict(),
    ),
    accountProfiles: z.record(
      identifierSchema,
      z
        .object({
          driverId: z.string().min(1),
          enabled: z.boolean(),
          hostIds: z.array(identifierSchema).min(1),
        })
        .strict(),
    ),
    usageByAccountId: z.record(
      identifierSchema,
      accountUsageSnapshotSchema.nullable(),
    ),
    activeClaims: z.array(dispatchClaimSchema),
    activeLanes: z.array(workLaneSchema),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/u),
    target: z.enum(["shared", "desktop", "pwa", "website"]),
    now: z.iso.datetime(),
  }).strict();

export function assembleReconciledAdmissionCandidate(
  input: ReconciledAdmissionCandidateInput,
): SymphonyAdmissionCandidate {
  const snapshot = reconciledAdmissionCandidateInputSchema.parse(input);
  const qualification = snapshot.qualification;
  const authorityTask = snapshot.authorityTask;
  const intendedClaim = snapshot.intendedClaim;
  if (snapshot.activeClaims.length !== snapshot.activeLanes.length) {
    throw new Error("Active claim and lane observations are not one-to-one.");
  }
  const conflict = decideConflict({
    candidate: qualification,
    activeClaims: snapshot.activeClaims,
    activeLanes: snapshot.activeLanes,
    policy: PILOT_CONCURRENCY_POLICY,
  });
  if (!conflict.allowed) {
    throw new Error(`Candidate conflicts with active work: ${conflict.reason}.`);
  }
  const nowMs = Date.parse(snapshot.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Reconciler time is invalid.");
  }
  const freshHosts = snapshot.hosts.map((host) => {
    const observedAtMs = Date.parse(host.lastHeartbeatAt);
    const ageSeconds = (nowMs - observedAtMs) / 1_000;
    return {
      ...host,
      online:
        host.online &&
        Number.isFinite(ageSeconds) &&
        ageSeconds >= 0 &&
        ageSeconds <= HOST_HEARTBEAT_MAX_AGE_SECONDS,
    };
  });
  const route = planExecutionRouteFromState({
    requiredLane: qualification.hostLane,
    hosts: freshHosts,
    profiles: snapshot.accountProfiles,
    usageByAccountId: snapshot.usageByAccountId,
    now: snapshot.now,
  });
  if (route.route === undefined) {
    throw new Error(`No safe execution route is available: ${route.reason}.`);
  }
  if (route.route.hostId !== intendedClaim.hostId) {
    throw new Error(
      `Intended claim host does not match the selected route: ${route.route.hostId}.`,
    );
  }
  const selectedHost = freshHosts.find(
    (host) => host.id === route.route?.hostId && host.online,
  );
  if (selectedHost === undefined) {
    throw new Error("Selected route host is absent from the reconciled host set.");
  }
  const usage = snapshot.usageByAccountId[route.route.accountId];
  if (usage === undefined || usage === null) {
    throw new Error("Selected route lost its quota observation.");
  }
  const binding: ExecutionAdmissionBinding = {
    qualification,
    authorityTask,
    claim: intendedClaim,
    accountId: route.route.accountId,
    driverId: route.route.driverId,
    baseHead: snapshot.baseHead,
    target: snapshot.target,
  };
  return prepareSymphonyAdmissionCandidate(
    {
      schemaVersion: 1,
      preparedAt: snapshot.now,
      selectedHost: {
        id: selectedHost.id,
        lane: selectedHost.lane,
      },
      usage: accountUsageSnapshotSchema.parse(usage),
      binding,
    },
    snapshot.now,
  );
}
