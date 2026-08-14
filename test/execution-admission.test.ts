import { describe, expect, it } from "vitest";
import {
  assertExecutionAdmission,
  createExecutionAdmissionDigest,
  type ExecutionAdmissionBinding,
} from "../src/adapters/execution-admission.js";
import { authorityTask, claim, report } from "./helpers.js";

const binding: ExecutionAdmissionBinding = {
  qualification: report(),
  authorityTask: authorityTask(),
  claim: claim(),
  accountId: "codex-pro-1",
  driverId: "codex-app-server-v1",
  baseHead: "a".repeat(40),
  target: "shared",
};

function admission() {
  return {
    schemaVersion: 1 as const,
    bridgeId: "freed-task-claim-v1",
    authorityClaimId: binding.claim.claimId,
    taskId: binding.authorityTask.id,
    taskRevision: binding.authorityTask.revision,
    bindingDigest: createExecutionAdmissionDigest(binding),
    authorizedAt: "2026-08-13T07:59:00.000Z",
    expiresAt: "2026-08-13T08:05:00.000Z",
  };
}

describe("execution authority admission", () => {
  it("binds the exact task, claim, route, base commit, and workspace target", () => {
    expect(
      assertExecutionAdmission({
        admission: admission(),
        binding,
        now: "2026-08-13T08:00:00.000Z",
      }),
    ).toEqual(admission());
    expect(() =>
      assertExecutionAdmission({
        admission: admission(),
        binding: { ...binding, accountId: "codex-pro-2" },
        now: "2026-08-13T08:00:00.000Z",
      }),
    ).toThrow("does not bind the dispatch");
    expect(() =>
      assertExecutionAdmission({
        admission: admission(),
        binding: { ...binding, driverId: "grok-api-v1" },
        now: "2026-08-13T08:00:00.000Z",
      }),
    ).toThrow("does not bind the dispatch");
  });

  it("rejects task substitution and expired authority", () => {
    expect(() =>
      assertExecutionAdmission({
        admission: { ...admission(), taskRevision: 2 },
        binding,
        now: "2026-08-13T08:00:00.000Z",
      }),
    ).toThrow("changes the authority task");
    expect(() =>
      assertExecutionAdmission({
        admission: admission(),
        binding,
        now: "2026-08-13T08:05:00.000Z",
      }),
    ).toThrow("outside its valid lifetime");
    expect(() =>
      assertExecutionAdmission({
        admission: { ...admission(), authorityClaimId: "another-claim" },
        binding,
        now: "2026-08-13T08:00:00.000Z",
      }),
    ).toThrow("changes the task-scoped claim");
  });
});
