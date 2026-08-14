import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FreedClaimHeartbeatReceipt,
  FreedClaimHeartbeatRequest,
} from "../../adapters/freed/claim-broker.js";
import { canonicalJsonEqual } from "../../security/canonical-json.js";
import {
  symphonyAdmissionEnvelopeSchema,
  type SymphonyAdmissionEnvelope,
} from "./admission-envelope.js";

export interface FreedClaimHeartbeatWriter {
  heartbeat(
    request: FreedClaimHeartbeatRequest,
  ): Promise<FreedClaimHeartbeatReceipt>;
}

export async function heartbeatSymphonyActiveClaim(input: {
  readonly envelope: SymphonyAdmissionEnvelope;
  readonly broker: FreedClaimHeartbeatWriter;
  readonly now: string;
  readonly operationId?: string;
}): Promise<FreedClaimHeartbeatReceipt> {
  const envelope = symphonyAdmissionEnvelopeSchema.parse(input.envelope);
  const heartbeatAt = z.iso.datetime().parse(input.now);
  const request: FreedClaimHeartbeatRequest = {
    schemaVersion: 1,
    operationId: input.operationId ?? randomUUID(),
    taskId: envelope.admission.taskId,
    taskRevision: envelope.admission.taskRevision,
    authorityClaimId: envelope.admission.authorityClaimId,
    custodyEpoch: envelope.binding.claim.custodyEpoch,
    bindingDigest: envelope.admission.bindingDigest,
    heartbeatAt,
    executionStage: "running",
  };
  const receipt = await input.broker.heartbeat(request);
  if (!canonicalJsonEqual(receipt, request)) {
    throw new Error("Freed active-claim heartbeat receipt changed the exact claim.");
  }
  return receipt;
}
