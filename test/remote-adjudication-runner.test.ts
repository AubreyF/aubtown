import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { createAdjudicationCommand } from "../src/adjudication/command.js";
import { SshAdjudicationRunner } from "../src/adjudication/remote-runner.js";
import type {
  IndependentReviewReceipt,
  WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import type { TrustedAdjudicationResult } from "../src/adjudication/trusted-runner.js";
import type { SshWorkerPolicyVerifier } from "../src/security/ssh-worker-policy.js";
import { FREED_REPOSITORY, report, usage } from "./helpers.js";

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  branch: "fix/deterministic-validation",
  worktree: "/srv/aubtown/worktrees/freed/1234",
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead: "a".repeat(40),
  head: "b".repeat(40),
  patchDigest: "c".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

const command = createAdjudicationCommand({
  commandId: "60e13459-412e-41f7-809f-0d91dc660d52",
  workProduct,
  qualification: report(),
  accountId: "codex-pro-1",
  usageAtAdmission: usage(),
  reviewerDriverId: "codex-app-server-review-v1",
  validationCommands: [
    { executable: "/usr/bin/true", args: [], timeoutMs: 60_000 },
  ],
  issuedAt: "2026-08-13T18:00:00.000Z",
});

const review: IndependentReviewReceipt = {
  schemaVersion: 1,
  kind: "independent-review",
  workProduct,
  reviewer: {
    driverId: "codex-app-server-review-v1",
    threadId: "review-thread",
    turnId: "review-turn",
  },
  verdict: "pass",
  findings: [],
  completedAt: "2026-08-13T18:00:03.000Z",
  summary: "Review passed.",
};

const result: TrustedAdjudicationResult = {
  schemaVersion: 1,
  kind: "trusted-adjudication",
  commandId: command.commandId,
  outcome: "ready",
  validation: {
    schemaVersion: 1,
    kind: "exact-validation",
    workProduct,
    passed: true,
    commands: [
      {
        argv: ["/usr/bin/true"],
        cwd: workProduct.worktree,
        exitCode: 0,
        outputDigest: "e".repeat(64),
        durationMs: 10,
      },
    ],
    completedAt: "2026-08-13T18:00:01.000Z",
    summary: "Validation passed.",
  },
  review,
  completedAt: "2026-08-13T18:00:04.000Z",
};

const policy: SshWorkerPolicyVerifier = {
  verify: async (input) => ({
    hostId: input.hostId,
    hostname: `${input.hostId}.tailnet.example`,
    user: "aubtown-executor",
    identityFile: "/etc/aubtown/ssh/worker_ed25519",
    knownHostsFile: "/etc/aubtown/ssh/known_hosts",
    configSha256: "f".repeat(64),
    sshExecutableSha256: "0".repeat(64),
  }),
};

class Runner implements CommandRunner {
  request?: CommandRequest;
  constructor(private readonly output: unknown) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.request = request;
    return { stdout: `${JSON.stringify(this.output)}\n`, stderr: "" };
  }
}

function remote(runner: CommandRunner): SshAdjudicationRunner {
  return new SshAdjudicationRunner(
    runner,
    {
      sshExecutable: "/usr/bin/ssh",
      sshConfig: "/etc/aubtown/ssh/config",
      commandCwd: "/var/lib/aubtown/symphony",
      remoteNodeExecutable: "/opt/aubtown/node/bin/node",
      remoteAdjudicatorExecutable:
        "/opt/aubtown/releases/test/adjudicate-symphony-completion.js",
      remoteWorkerRuntimeConfig: "/etc/aubtown/worker-runtime.json",
      remoteReviewerRuntimeConfig: "/etc/aubtown/reviewer-runtime.json",
      expectedUser: "aubtown-executor",
      expectedIdentityFile: "/etc/aubtown/ssh/worker_ed25519",
      expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
    },
    policy,
  );
}

describe("SshAdjudicationRunner", () => {
  it("runs one exact adjudication command through the enrolled executor", async () => {
    const runner = new Runner(result);
    await expect(remote(runner).run(command)).resolves.toEqual(result);
    const request = runner.request;
    expect(request).toMatchObject({
      executable: "/usr/bin/ssh",
      args: [
        "-F",
        "/etc/aubtown/ssh/config",
        "--",
        workProduct.hostId,
        "/opt/aubtown/node/bin/node",
        "/opt/aubtown/releases/test/adjudicate-symphony-completion.js",
        "/etc/aubtown/worker-runtime.json",
        "/etc/aubtown/reviewer-runtime.json",
        expect.any(String),
      ],
    });
    const payload = request?.args.at(-1);
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
    ).toEqual(command);
  });

  it("rejects a receipt for a substituted work product", async () => {
    await expect(
      remote(
        new Runner({
          ...result,
          validation: {
            ...result.validation,
            workProduct: { ...workProduct, branch: "fix/substituted" },
          },
        }),
      ).run(command),
    ).rejects.toThrow("changes its work product");
  });
});
