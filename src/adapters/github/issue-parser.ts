import type { IssueEvidence } from "../../domain/types.js";

const HEADING_MAP: Readonly<Record<string, keyof IssueEvidence>> = {
  "root cause": "rootCause",
  evidence: "evidence",
  "why this is deferred": "scope",
  "done when": "acceptanceCriteria",
  "scope and gates": "scope",
};

const WORK_LANES = new Set([
  "runtime-neutral",
  "behavioral",
  "provider-visible",
  "integration",
  "release",
  "macos",
  "sensitive",
]);

function sections(body: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let active: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (active !== undefined) {
      result.set(active, lines.join("\n").trim());
    }
  };
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#{2,4}\s+(.+)$/u.exec(line);
    if (match !== null) {
      flush();
      active = match[1]?.trim().toLowerCase();
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return result;
}

function list(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const values = value
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s+/u, "").trim())
    .filter(Boolean);
  return values.length === 0 ? undefined : values;
}

function scalar(value: string | undefined): string | undefined {
  const parsed = value?.trim();
  return parsed === undefined || parsed.length === 0 ? undefined : parsed;
}

function boolean(value: string | undefined): boolean | undefined {
  const parsed = scalar(value)?.toLowerCase();
  return parsed === "true" ? true : parsed === "false" ? false : undefined;
}

function issueNumbers(value: string | undefined): readonly number[] | undefined {
  const parsed = list(value)
    ?.map((entry) => /^#?(\d+)$/u.exec(entry)?.[1])
    .filter((entry): entry is string => entry !== undefined)
    .map(Number);
  return parsed === undefined || parsed.length === 0 ? undefined : parsed;
}

export function parseDebtIssueBody(body: string): IssueEvidence {
  const parsed = sections(body);
  const values: Partial<Record<keyof IssueEvidence, string>> = {};
  for (const [heading, key] of Object.entries(HEADING_MAP)) {
    const value = parsed.get(heading);
    if (value !== undefined && value.length > 0) {
      values[key] = value;
    }
  }
  const hostLane = scalar(parsed.get("host lane"));
  const workLane = scalar(parsed.get("work lane"));
  const duplicateOf = issueNumbers(parsed.get("duplicate of"))?.[0];
  return {
    ...(values.rootCause === undefined ? {} : { rootCause: values.rootCause }),
    ...(values.evidence === undefined ? {} : { evidence: values.evidence }),
    ...(values.scope === undefined ? {} : { scope: values.scope }),
    ...(parsed.get("done when") === undefined
      ? {}
      : { acceptanceCriteria: list(parsed.get("done when")) }),
    ...(parsed.get("validation") === undefined
      ? {}
      : { validation: list(parsed.get("validation")) }),
    ...(parsed.get("dependencies") === undefined
      ? {}
      : { dependencies: issueNumbers(parsed.get("dependencies")) }),
    ...(parsed.get("owned paths") === undefined
      ? {}
      : { ownedPaths: list(parsed.get("owned paths")) }),
    ...(parsed.get("logical locks") === undefined
      ? {}
      : { logicalLocks: list(parsed.get("logical locks")) }),
    ...(hostLane === "linux" || hostLane === "macos" ? { hostLane } : {}),
    ...(workLane !== undefined && WORK_LANES.has(workLane)
      ? { lane: workLane as NonNullable<IssueEvidence["lane"]> }
      : {}),
    ...(parsed.get("provider names") === undefined
      ? {}
      : { providerNames: list(parsed.get("provider names")) }),
    ...(boolean(parsed.get("requires owner review")) === undefined
      ? {}
      : { requiresOwnerReview: boolean(parsed.get("requires owner review")) }),
    ...(boolean(parsed.get("behavioral")) === undefined
      ? {}
      : { behavioral: boolean(parsed.get("behavioral")) }),
    ...(boolean(parsed.get("release or migration risk")) === undefined
      ? {}
      : {
          releaseOrMigrationRisk: boolean(
            parsed.get("release or migration risk"),
          ),
        }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
}
