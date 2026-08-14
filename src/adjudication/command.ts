import { z } from "zod";
import { qualificationReportSchema } from "../execution/command.js";
import { canonicalJsonEqual } from "../security/canonical-json.js";
import {
  validationCommandSchema,
  type ValidationCommand,
} from "./validation-runner.js";
import {
  workProductIdentitySchema,
  type WorkProductIdentity,
} from "./receipts.js";
import type { QualificationReport } from "../domain/types.js";
import { accountUsageSnapshotSchema } from "../domain/schemas.js";
import type { AccountUsageSnapshot } from "../domain/types.js";

export const adjudicationCommandSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.uuid(),
  action: z.literal("adjudicate"),
  workProduct: workProductIdentitySchema,
  qualification: qualificationReportSchema,
  accountId: z.string().min(1),
  usageAtAdmission: accountUsageSnapshotSchema,
  reviewerDriverId: z.literal("codex-app-server-review-v1"),
  validationCommands: z.array(validationCommandSchema).min(1).max(16),
  issuedAt: z.iso.datetime(),
});

export type AdjudicationCommand = z.infer<typeof adjudicationCommandSchema>;

export function createAdjudicationCommand(input: {
  readonly commandId: string;
  readonly workProduct: WorkProductIdentity;
  readonly qualification: QualificationReport;
  readonly accountId: string;
  readonly usageAtAdmission: AccountUsageSnapshot;
  readonly reviewerDriverId: "codex-app-server-review-v1";
  readonly validationCommands: readonly ValidationCommand[];
  readonly issuedAt: string;
}): AdjudicationCommand {
  return assertAdjudicationCommand({
    schemaVersion: 1,
    commandId: input.commandId,
    action: "adjudicate",
    workProduct: input.workProduct,
    qualification: input.qualification,
    accountId: input.accountId,
    usageAtAdmission: input.usageAtAdmission,
    reviewerDriverId: input.reviewerDriverId,
    validationCommands: input.validationCommands,
    issuedAt: input.issuedAt,
  });
}

export function assertAdjudicationCommand(
  value: unknown,
  targetHostId?: string,
): AdjudicationCommand {
  const command = adjudicationCommandSchema.parse(value);
  const product = command.workProduct;
  const qualification = command.qualification;
  if (targetHostId !== undefined && product.hostId !== targetHostId) {
    throw new Error("Adjudication command targets another host.");
  }
  if (!qualification.eligible) {
    throw new Error("Adjudication command contains an ineligible qualification.");
  }
  if (command.usageAtAdmission.accountId !== command.accountId) {
    throw new Error("Adjudication command quota snapshot targets another account.");
  }
  if (
    product.repository.owner !== qualification.repository.owner ||
    product.repository.name !== qualification.repository.name ||
    product.repository.defaultBranch !== qualification.repository.defaultBranch ||
    product.issueNumber !== qualification.issue.number
  ) {
    throw new Error("Adjudication work product does not match qualification.");
  }
  return command;
}

export function sameAdjudicationCommand(
  left: AdjudicationCommand,
  right: AdjudicationCommand,
): boolean {
  return canonicalJsonEqual(left, right);
}
