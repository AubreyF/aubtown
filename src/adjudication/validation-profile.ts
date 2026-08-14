import path from "node:path";
import { z } from "zod";
import type { QualificationReport } from "../domain/types.js";
import { loadProtectedJsonFile } from "../security/protected-json.js";
import {
  validationCommandSchema,
  type ValidationCommand,
} from "./validation-runner.js";

export const reviewedValidationProfileSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  requirements: z
    .array(
      z.object({
        text: z.string().min(1),
        command: validationCommandSchema,
      }),
    )
    .min(1)
    .max(32),
});

export type ReviewedValidationProfile = z.infer<
  typeof reviewedValidationProfileSchema
>;

export async function loadReviewedValidationProfile(
  file: string,
): Promise<ReviewedValidationProfile> {
  if (!path.isAbsolute(file)) {
    throw new Error("Reviewed validation profile path must be absolute.");
  }
  return reviewedValidationProfileSchema.parse(
    await loadProtectedJsonFile({
      file,
      label: "Reviewed validation profile",
    }),
  );
}

export function resolveReviewedValidationCommands(input: {
  readonly profile: ReviewedValidationProfile;
  readonly qualification: QualificationReport;
}): readonly ValidationCommand[] {
  const profile = reviewedValidationProfileSchema.parse(input.profile);
  const qualification = input.qualification;
  if (
    profile.repository.owner !== qualification.repository.owner ||
    profile.repository.name !== qualification.repository.name ||
    profile.repository.defaultBranch !==
      qualification.repository.defaultBranch
  ) {
    throw new Error("Reviewed validation profile targets another repository.");
  }
  const requirements = qualification.evidence.validation ?? [];
  if (requirements.length === 0) {
    throw new Error("Qualified work has no exact validation requirements.");
  }
  const byText = new Map<string, ValidationCommand>();
  for (const entry of profile.requirements) {
    if (byText.has(entry.text)) {
      throw new Error("Reviewed validation profile contains duplicate text.");
    }
    byText.set(entry.text, entry.command);
  }
  return requirements.map((requirement) => {
    const command = byText.get(requirement);
    if (command === undefined) {
      throw new Error(
        `Validation requirement is not in the reviewed command catalog: ${requirement}`,
      );
    }
    return command;
  });
}
