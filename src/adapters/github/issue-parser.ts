import type { IssueEvidence } from "../../domain/types.js";

const HEADING_MAP: Readonly<Record<string, keyof IssueEvidence>> = {
  "root cause": "rootCause",
  evidence: "evidence",
  "why this is deferred": "scope",
  "done when": "acceptanceCriteria",
  "scope and gates": "scope",
};

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

export function parseDebtIssueBody(body: string): IssueEvidence {
  const parsed = sections(body);
  const values: Partial<Record<keyof IssueEvidence, string>> = {};
  for (const [heading, key] of Object.entries(HEADING_MAP)) {
    const value = parsed.get(heading);
    if (value !== undefined && value.length > 0) {
      values[key] = value;
    }
  }
  return {
    ...(values.rootCause === undefined ? {} : { rootCause: values.rootCause }),
    ...(values.evidence === undefined ? {} : { evidence: values.evidence }),
    ...(values.scope === undefined ? {} : { scope: values.scope }),
    ...(parsed.get("done when") === undefined
      ? {}
      : { acceptanceCriteria: list(parsed.get("done when")) }),
  };
}
