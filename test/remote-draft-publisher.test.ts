import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import type { SshWorkerPolicyVerifier } from "../src/security/ssh-worker-policy.js";
import { SshDraftPublisher } from "../src/publication/remote-runner.js";
import type { DraftPublicationReceipt } from "../src/publication/draft-publisher.js";
import type { PublicationPlan } from "../src/publication/policy.js";
import type { WorkProductIdentity } from "../src/adjudication/receipts.js";
import { claim, FREED_REPOSITORY } from "./helpers.js";

const workProduct: WorkProductIdentity = {
  schemaVersion: 1,
  repository: FREED_REPOSITORY,
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "macos-executor-1",
  branch: claim().branch,
  worktree: "/Users/aubrey/worktrees/freed-issue-1234",
  commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
  checkpointReference: "d".repeat(64),
  baseHead: "a".repeat(40),
  head: "c".repeat(40),
  patchDigest: "e".repeat(64),
  implementation: {
    driverId: "codex-app-server-v1",
    threadId: "implementation-thread",
    turnId: "implementation-turn",
  },
};

const plan: PublicationPlan = {
  allowed: true,
  action: "create-draft",
  reasons: [],
  repository: "freed-project/freed",
  title: "fix: make validation deterministic",
  branch: workProduct.branch,
  head: workProduct.head,
  body: "(AI Generated).\n\nMakes validation deterministic.",
  workProduct,
};

const receipt: DraftPublicationReceipt = {
  schemaVersion: 1,
  repository: "freed-project/freed",
  checkpointReference: workProduct.checkpointReference,
  branch: workProduct.branch,
  head: workProduct.head,
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/freed-project/freed/pull/42",
  draft: true,
  publishedAt: "2026-08-14T11:00:00.000Z",
  tokenExpiresAt: "2026-08-14T12:00:00.000Z",
};

describe("remote draft publication", () => {
  it("routes the non-secret plan to the custody host and binds its receipt", async () => {
    const calls: CommandRequest[] = [];
    const policyHosts: string[] = [];
    const runner: CommandRunner = {
      run: async (request) => {
        calls.push(request);
        return { stdout: `${JSON.stringify(receipt)}\n`, stderr: "" };
      },
    };
    const policy: SshWorkerPolicyVerifier = {
      verify: async (input) => {
        policyHosts.push(input.hostId);
        return {
          hostId: input.hostId,
          hostname: "macos-executor.tailnet.invalid",
          user: input.expectedUser,
          identityFile: input.expectedIdentityFile,
          knownHostsFile: input.expectedKnownHostsFile,
          configSha256: "1".repeat(64),
          sshExecutableSha256: "2".repeat(64),
        };
      },
    };
    const publisher = new SshDraftPublisher(
      runner,
      {
        sshExecutable: "/usr/bin/ssh",
        sshConfig: "/etc/aubtown/ssh/config",
        commandCwd: "/var/lib/aubtown/symphony",
        remoteHostAlias: "macos-executor-1-publisher",
        remoteNodeExecutable: "/opt/aubtown/node/bin/node",
        remotePublisherExecutable:
          "/opt/aubtown/current/dist/cli/publish-draft-local.js",
        remotePublisherRuntime: "/etc/aubtown/publisher-runtime.json",
        expectedUser: "aubtown-publisher",
        expectedIdentityFile: "/etc/aubtown/ssh/publisher_ed25519",
        expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
        requiredConfigUid: 0,
      },
      policy,
    );

    await expect(publisher.publish(plan)).resolves.toEqual(receipt);
    expect(policyHosts).toEqual(["macos-executor-1-publisher"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      "-F",
      "/etc/aubtown/ssh/config",
      "--",
      "macos-executor-1-publisher",
      "/opt/aubtown/node/bin/node",
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("token");
    const payload = calls[0]?.args.at(-1);
    expect(payload).toBeDefined();
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
    ).toEqual(plan);
  });

  it("rejects a receipt for another exact head", async () => {
    const runner: CommandRunner = {
      run: async () => ({
        stdout: `${JSON.stringify({ ...receipt, head: "9".repeat(40) })}\n`,
        stderr: "",
      }),
    };
    const publisher = new SshDraftPublisher(
      runner,
      {
        sshExecutable: "/usr/bin/ssh",
        sshConfig: "/etc/aubtown/ssh/config",
        commandCwd: "/var/lib/aubtown/symphony",
        remoteHostAlias: "macos-executor-1-publisher",
        remoteNodeExecutable: "/opt/aubtown/node/bin/node",
        remotePublisherExecutable:
          "/opt/aubtown/current/dist/cli/publish-draft-local.js",
        remotePublisherRuntime: "/etc/aubtown/publisher-runtime.json",
        expectedUser: "aubtown-publisher",
        expectedIdentityFile: "/etc/aubtown/ssh/publisher_ed25519",
        expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
      },
      {
        verify: async (input) => ({
          hostId: input.hostId,
          hostname: "macos-executor.tailnet.invalid",
          user: input.expectedUser,
          identityFile: input.expectedIdentityFile,
          knownHostsFile: input.expectedKnownHostsFile,
          configSha256: "1".repeat(64),
          sshExecutableSha256: "2".repeat(64),
        }),
      },
    );

    await expect(publisher.publish(plan)).rejects.toThrow(
      "does not match its admitted plan",
    );
  });
});
