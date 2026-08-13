import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import {
  verifyCodexCompatibility,
  verifyCodexProtocolBundle,
} from "../src/drivers/codex/compatibility.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      await rm(directory, { recursive: true, force: true }),
    ),
  );
});

function protocolBundle(): Record<string, string> {
  return {
    "ClientRequest.json": JSON.stringify([
      "thread/start",
      "turn/start",
      "turn/interrupt",
      "account/rateLimits/read",
      "account/usage/read",
      "model/list",
    ]),
    "ServerNotification.json": JSON.stringify(["turn/completed"]),
    "v2/ThreadStartParams.json": JSON.stringify([
      "cwd",
      "model",
      "approvalPolicy",
      "sandbox",
      "serviceName",
    ]),
    "v2/ThreadResumeParams.json": JSON.stringify([
      "threadId",
      "cwd",
      "model",
      "approvalPolicy",
      "sandbox",
    ]),
    "v2/ThreadResumeResponse.json": JSON.stringify([
      "thread",
      "turns",
      "id",
      "status",
    ]),
    "v2/TurnStartParams.json": JSON.stringify([
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
    ]),
    "v2/TurnInterruptParams.json": JSON.stringify(["threadId", "turnId"]),
    "v2/TurnCompletedNotification.json": JSON.stringify([
      "turn",
      "id",
      "status",
    ]),
    "v2/GetAccountRateLimitsResponse.json": JSON.stringify([
      "rateLimits",
      "rateLimitsByLimitId",
      "primary",
      "secondary",
      "usedPercent",
      "windowDurationMins",
      "resetsAt",
    ]),
    "v2/GetAccountTokenUsageResponse.json": JSON.stringify([
      "summary",
      "dailyUsageBuckets",
    ]),
    "v2/ModelListResponse.json": JSON.stringify([
      "data",
      "nextCursor",
      "model",
      "hidden",
      "supportedReasoningEfforts",
      "reasoningEffort",
    ]),
  };
}

class CompatibilityRunner implements CommandRunner {
  constructor(private readonly version: string) {}

  async run(request: CommandRequest) {
    if (request.args[0] === "--version") {
      return { stdout: `${this.version}\n`, stderr: "" };
    }
    const outputIndex = request.args.indexOf("--out");
    const output = request.args[outputIndex + 1];
    if (output === undefined) {
      throw new Error("Schema output was not provided.");
    }
    for (const [path, source] of Object.entries(protocolBundle())) {
      await mkdir(join(output, path, ".."), { recursive: true });
      await writeFile(join(output, path), source, "utf8");
    }
    return { stdout: "", stderr: "" };
  }
}

describe("Codex compatibility", () => {
  it("rejects an app-server schema missing a governed method", () => {
    const bundle = protocolBundle();
    bundle["ClientRequest.json"] = JSON.stringify(["thread/start"]);
    expect(() => verifyCodexProtocolBundle(bundle)).toThrow(
      "does not advertise turn/start",
    );
  });

  it("pins the executable, exact version, and generated protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "freedworks-codex-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(executable, "test binary", "utf8");
    await chmod(executable, 0o700);
    const receipt = await verifyCodexCompatibility({
      executable,
      expectedVersion: "codex-cli 1.2.3",
      runner: new CompatibilityRunner("codex-cli 1.2.3"),
    });
    expect(receipt).toMatchObject({
      executable: await realpath(executable),
      version: "codex-cli 1.2.3",
    });
    expect(receipt.protocolDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed after an unreviewed executable version change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "freedworks-codex-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(executable, "test binary", "utf8");
    await chmod(executable, 0o700);
    await expect(
      verifyCodexCompatibility({
        executable,
        expectedVersion: "codex-cli 1.2.3",
        runner: new CompatibilityRunner("codex-cli 1.2.4"),
      }),
    ).rejects.toThrow("Expected codex-cli 1.2.3, found codex-cli 1.2.4");
  });
});
