import { z } from "zod";

const hostPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SymphonyPrelaunchRequest {
  readonly schemaVersion: 1;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly workerHost: string;
}

export interface SymphonyPrelaunchResponse {
  readonly schemaVersion: 1;
  readonly decision: "admit" | "deny";
  readonly issueId: string;
  readonly workerHost: string;
  readonly receiptId?: string;
  readonly reason?: string;
}

const requestSchema: z.ZodType<SymphonyPrelaunchRequest> = z
  .object({
    schemaVersion: z.literal(1),
    issueId: z.string().regex(/^[1-9][0-9]*$/u),
    issueIdentifier: z.string().regex(/^GH-[1-9][0-9]*$/u),
    workerHost: z.string().regex(hostPattern),
  })
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

export function parseSymphonyPrelaunchRequest(
  args: readonly string[],
): SymphonyPrelaunchRequest {
  const known = new Set([
    "--schema-version",
    "--issue-id",
    "--issue-identifier",
    "--worker-host",
  ]);
  if (args.length !== known.size * 2) {
    throw new Error("Symphony prelaunch received an incomplete argument set.");
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? "")) {
      throw new Error("Symphony prelaunch received an unknown argument.");
    }
  }
  return requestSchema.parse({
    schemaVersion: Number(oneArgument(args, "--schema-version")),
    issueId: oneArgument(args, "--issue-id"),
    issueIdentifier: oneArgument(args, "--issue-identifier"),
    workerHost: oneArgument(args, "--worker-host"),
  });
}

export function denySymphonyPrelaunch(
  request: SymphonyPrelaunchRequest,
  reason: string,
): SymphonyPrelaunchResponse {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(reason)) {
    throw new Error("Symphony prelaunch denial reason is invalid.");
  }
  return {
    schemaVersion: 1,
    decision: "deny",
    issueId: request.issueId,
    workerHost: request.workerHost,
    reason,
  };
}

export function admitSymphonyPrelaunch(
  request: SymphonyPrelaunchRequest,
  receiptId: string,
): SymphonyPrelaunchResponse {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(receiptId)) {
    throw new Error("Symphony prelaunch receipt ID is invalid.");
  }
  return {
    schemaVersion: 1,
    decision: "admit",
    issueId: request.issueId,
    workerHost: request.workerHost,
    receiptId,
  };
}
