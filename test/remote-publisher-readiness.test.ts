import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { SshPublisherReadinessProbe } from "../src/publication/remote-publisher-readiness.js";
import type { SshWorkerPolicyVerifier } from "../src/security/ssh-worker-policy.js";

const report = {
  schemaVersion: 1 as const,
  hostId: "macos-executor-1",
  checkedAt: "2026-08-14T13:00:00.000Z",
  ready: true as const,
  runtime: {
    path: "/etc/aubtown/publisher-runtime.json",
    sha256: "1".repeat(64),
  },
  publisher: {
    path: "/opt/aubtown/current/dist/cli/publish-draft-local.js",
    sha256: "2".repeat(64),
  },
  git: { executable: "/usr/bin/git", version: "git version 2.50.1" },
  node: { executable: "/opt/aubtown/node/bin/node", version: "v24.14.1" },
  privateKey: {
    path: "/etc/aubtown/publisher/draft-publisher-private.pem",
    ownerUid: 502,
    mode: "0600" as const,
  },
  selectedRepositories: ["freed-project/freed"],
  worktreeRoots: ["/Users/aubtown/Library/Application Support/AubTown/workspaces"],
};

describe("remote publisher readiness", () => {
  it("uses only the dedicated publisher alias and identity", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = {
      run: async (request) => {
        calls.push(request);
        return { stdout: `${JSON.stringify(report)}\n`, stderr: "" };
      },
    };
    const policy: SshWorkerPolicyVerifier = {
      verify: async (input) => ({
        hostId: input.hostId,
        hostname: "macos-executor.tailnet.invalid",
        user: input.expectedUser,
        identityFile: input.expectedIdentityFile,
        knownHostsFile: input.expectedKnownHostsFile,
        configSha256: "3".repeat(64),
        sshExecutableSha256: "4".repeat(64),
      }),
    };
    const result = await new SshPublisherReadinessProbe(
      runner,
      {
        sshExecutable: "/usr/bin/ssh",
        sshConfig: "/etc/aubtown/ssh/config",
        commandCwd: "/var/lib/aubtown/symphony",
        remoteNodeExecutable: "/opt/aubtown/node/bin/node",
        remoteProbeExecutable:
          "/opt/aubtown/current/dist/cli/probe-publisher-readiness-local.js",
        remoteRuntimeConfig: "/etc/aubtown/publisher-runtime.json",
        remotePublisherExecutable:
          "/opt/aubtown/current/dist/cli/publish-draft-local.js",
        expectedUser: "aubtown-publisher",
        expectedIdentityFile: "/etc/aubtown/ssh/publisher_ed25519",
        expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
      },
      policy,
    ).probe("macos-executor-1");
    expect(result.transport).toMatchObject({
      hostId: "macos-executor-1-publisher",
      user: "aubtown-publisher",
    });
    expect(calls[0]?.args).toContain("macos-executor-1-publisher");
    expect(calls[0]?.args).not.toContain("macos-executor-1");
  });
});
