import type { DispatchClaim } from "../domain/types.js";

export type FactoryProjectionState =
  | "ready"
  | "running"
  | "blocked"
  | "human-review";

export type FactoryExecutionStage =
  | "qualification"
  | "awaiting-dispatch"
  | "planning"
  | "workspace"
  | "implementation"
  | "validation"
  | "independent-review"
  | "ci-repair"
  | "handoff"
  | "blocked";

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

export const STATUS_COMMENT_MARKER = "<!-- aubtown-status:v1 -->";

function oneLine(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) {
    throw new Error(`${name} must be one nonempty line.`);
  }
  return trimmed;
}

export function buildStatusProjection(input: {
  readonly state: FactoryProjectionState;
  readonly stage: FactoryExecutionStage;
  readonly summary: string;
  readonly claim?: DispatchClaim;
  readonly accountId?: string;
  readonly lastHeartbeatAt?: string;
  readonly draftPullRequest?: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly updatedAt: string;
}): StatusProjection {
  if (
    (input.state === "running" || input.state === "human-review") &&
    input.claim === undefined
  ) {
    throw new Error(`${input.state} status requires a durable claim.`);
  }
  if (input.state === "ready" && input.claim !== undefined) {
    throw new Error("ready status cannot carry an execution claim.");
  }
  if (input.state === "blocked" && input.blocker === undefined) {
    throw new Error("blocked status requires a blocker.");
  }
  const activeLabel = LABEL_BY_STATE[input.state];
  const machineLabels = Object.values(LABEL_BY_STATE);
  const claim = input.claim;
  const value = (name: string, candidate: string | undefined): string =>
    candidate === undefined ? "none" : oneLine(name, candidate);
  return {
    labelsToAdd: [activeLabel],
    labelsToRemove: machineLabels.filter((label) => label !== activeLabel),
    commentBody: [
      "(AI Generated).",
      "",
      STATUS_COMMENT_MARKER,
      `Factory state: ${input.state}`,
      `Stage: ${input.stage}`,
      `Assigned host: ${value("Assigned host", claim?.hostId)}`,
      `Assigned worker: ${value("Assigned worker", claim?.workerId)}`,
      `Execution account: ${value("Execution account", input.accountId)}`,
      `Claim: ${value("Claim", claim?.claimId)}`,
      `Custody epoch: ${claim?.custodyEpoch.toLocaleString() ?? "none"}`,
      `Branch: ${value("Branch", claim?.branch)}`,
      `Last heartbeat: ${value("Last heartbeat", input.lastHeartbeatAt)}`,
      `Draft pull request: ${value("Draft pull request", input.draftPullRequest)}`,
      `Blocker: ${value("Blocker", input.blocker)}`,
      `Updated: ${oneLine("Updated", input.updatedAt)}`,
      "",
      `Summary: ${oneLine("Summary", input.summary)}`,
      `Next action: ${value("Next action", input.nextAction)}`,
    ].join("\n"),
  };
}

export function findManagedStatusComment<T extends { readonly body?: string | null }>(
  comments: readonly T[],
): T | undefined {
  return comments.find((comment) => comment.body?.includes(STATUS_COMMENT_MARKER));
}
