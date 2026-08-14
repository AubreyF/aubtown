import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProcessCommandRunner,
  type CommandRunner,
} from "../../adapters/command-runner.js";

const REQUIRED_PROTOCOL_FILES = {
  "ClientRequest.json": [
    "thread/start",
    "turn/start",
    "turn/interrupt",
    "account/rateLimits/read",
    "account/usage/read",
    "model/list",
  ],
  "ServerNotification.json": ["turn/completed", "item/completed"],
  "v2/ThreadStartParams.json": [
    "cwd",
    "model",
    "approvalPolicy",
    "sandbox",
    "serviceName",
  ],
  "v2/ThreadResumeParams.json": [
    "threadId",
    "cwd",
    "model",
    "approvalPolicy",
    "sandbox",
  ],
  "v2/ThreadResumeResponse.json": ["thread", "turns", "id", "status"],
  "v2/TurnStartParams.json": [
    "threadId",
    "input",
    "cwd",
    "approvalPolicy",
    "sandboxPolicy",
    "writableRoots",
    "networkAccess",
    "model",
    "effort",
    "summary",
    "outputSchema",
    "readOnly",
  ],
  "v2/ItemCompletedNotification.json": [
    "threadId",
    "turnId",
    "completedAtMs",
    "item",
    "agentMessage",
    "text",
    "phase",
    "final_answer",
  ],
  "v2/TurnInterruptParams.json": ["threadId", "turnId"],
  "v2/TurnCompletedNotification.json": ["turn", "id", "status"],
  "v2/GetAccountRateLimitsResponse.json": [
    "rateLimits",
    "rateLimitsByLimitId",
    "primary",
    "secondary",
    "usedPercent",
    "windowDurationMins",
    "resetsAt",
  ],
  "v2/GetAccountTokenUsageResponse.json": ["summary", "dailyUsageBuckets"],
  "v2/ModelListResponse.json": [
    "data",
    "nextCursor",
    "model",
    "hidden",
    "supportedReasoningEfforts",
    "reasoningEffort",
  ],
} as const;

export type CodexProtocolBundle = Readonly<Record<string, string>>;

export interface CodexCompatibilityReceipt {
  readonly executable: string;
  readonly version: string;
  readonly protocolDigest: string;
}

export function verifyCodexProtocolBundle(bundle: CodexProtocolBundle): string {
  const hash = createHash("sha256");
  for (const [path, requiredValues] of Object.entries(REQUIRED_PROTOCOL_FILES)) {
    const source = bundle[path];
    if (source === undefined) {
      throw new Error(`Codex app-server schema is missing ${path}.`);
    }
    try {
      JSON.parse(source);
    } catch {
      throw new Error(`Codex app-server schema ${path} is not valid JSON.`);
    }
    for (const value of requiredValues) {
      if (!source.includes(`"${value}"`)) {
        throw new Error(
          `Codex app-server schema ${path} does not advertise ${value}.`,
        );
      }
    }
    hash.update(path);
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function verifyCodexCompatibility(input: {
  readonly executable: string;
  readonly expectedVersion: string;
  readonly runner?: CommandRunner;
}): Promise<CodexCompatibilityReceipt> {
  if (!isAbsolute(input.executable)) {
    throw new Error("AUBTOWN_CODEX_EXECUTABLE must be an absolute path.");
  }
  if (input.expectedVersion.trim() !== input.expectedVersion || input.expectedVersion === "") {
    throw new Error("AUBTOWN_CODEX_VERSION must be an exact nonempty version string.");
  }
  const executable = await realpath(input.executable);
  const stats = await lstat(executable);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Codex executable must resolve to a physical file.");
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error("Codex executable is not executable.");
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error("Codex executable cannot be writable by group or other users.");
  }
  const runner = input.runner ?? new ProcessCommandRunner();
  const versionResult = await runner.run({
    executable,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  const version = versionResult.stdout.trim();
  if (version !== input.expectedVersion) {
    throw new Error(
      `Codex version mismatch. Expected ${input.expectedVersion}, found ${version || "no version"}.`,
    );
  }

  const schemaDirectory = await mkdtemp(join(tmpdir(), "aubtown-codex-schema-"));
  try {
    await runner.run({
      executable,
      args: ["app-server", "generate-json-schema", "--out", schemaDirectory],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxBufferBytes: 8 * 1_024 * 1_024,
    });
    const bundleEntries = await Promise.all(
      Object.keys(REQUIRED_PROTOCOL_FILES).map(async (path) => [
        path,
        await readFile(join(schemaDirectory, path), "utf8"),
      ] as const),
    );
    return {
      executable,
      version,
      protocolDigest: verifyCodexProtocolBundle(Object.fromEntries(bundleEntries)),
    };
  } finally {
    await rm(schemaDirectory, { recursive: true, force: true });
  }
}
