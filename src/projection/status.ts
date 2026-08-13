export type FactoryProjectionState =
  | "ready"
  | "running"
  | "blocked"
  | "human-review";

export interface StatusProjection {
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
  readonly commentBody: string;
}

const LABEL_BY_STATE: Record<FactoryProjectionState, string> = {
  ready: "factory:ready",
  running: "factory:running",
  blocked: "factory:blocked",
  "human-review": "factory:human-review",
};

export const STATUS_COMMENT_MARKER = "<!-- freedworks-status:v1 -->";

export function buildStatusProjection(input: {
  readonly state: FactoryProjectionState;
  readonly summary: string;
  readonly claimId?: string;
  readonly updatedAt: string;
}): StatusProjection {
  const activeLabel = LABEL_BY_STATE[input.state];
  const machineLabels = Object.values(LABEL_BY_STATE);
  const claimLine =
    input.claimId === undefined ? "Claim: none" : `Claim: ${input.claimId}`;
  return {
    labelsToAdd: [activeLabel],
    labelsToRemove: machineLabels.filter((label) => label !== activeLabel),
    commentBody: [
      "(AI Generated).",
      "",
      STATUS_COMMENT_MARKER,
      `Factory state: ${input.state}`,
      claimLine,
      `Updated: ${input.updatedAt}`,
      "",
      input.summary,
    ].join("\n"),
  };
}

export function findManagedStatusComment<T extends { readonly body?: string | null }>(
  comments: readonly T[],
): T | undefined {
  return comments.find((comment) => comment.body?.includes(STATUS_COMMENT_MARKER));
}
