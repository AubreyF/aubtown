import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { SshExecutorReadinessProbe } from "../src/execution/remote-executor-readiness.js";

const report = {
  schemaVersion: 1 as const,
  hostId: "linux-control-1",
  repository: { owner: "freed-project", name: "freed", defaultBranch: "dev" },
  checkedAt: "2026-08-13T22:00:00.000Z",
  ready: true as const,
  repositoryRoot: "/srv/freed/repository",
  worktreeRoot: "/var/lib/aubtown/workspaces",
  baseHead: "a".repeat(40),
  git: { executable: "/usr/bin/git", version: "git version 2.50.1" },
  node: { executable: "/opt/aubtown/node/bin/node", version: "v24.14.1" },
  helper: {
    path: "/srv/freed/repository/scripts/worktree-add.sh",
    sha256: "b".repeat(64),
  },
  preparer: {
    path: "/opt/aubtown/releases/test/prepare-symphony-workspace.js",
    sha256: "c".repeat(64),
  },
};

class Runner implements CommandRunner {
  request?: CommandRequest;
  constructor(private readonly output: unknown = report) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.request = request;
    return { stdout: `${JSON.stringify(this.output)}\n`, stderr: "" };
  }
}

function probe(runner: CommandRunner): SshExecutorReadinessProbe {
  return new SshExecutorReadinessProbe(runner, {
    sshExecutable: "/usr/bin/ssh",
    sshConfig: "/etc/aubtown/ssh/config",
    commandCwd: "/var/lib/aubtown/symphony",
    remoteNodeExecutable: "/opt/aubtown/node/bin/node",
    remoteProbeExecutable: "/opt/aubtown/releases/test/probe.js",
    remoteRuntimeConfig: "/etc/aubtown/worker-runtime.json",
    remoteWorkspacePreparer: "/opt/aubtown/releases/test/preparer.js",
  });
}

describe("remote executor readiness", () => {
  it("runs one fixed probe through the selected Symphony SSH alias", async () => {
    const runner = new Runner();
    await expect(probe(runner).probe("linux-control-1")).resolves.toEqual(report);
    expect(runner.request).toMatchObject({
      executable: "/usr/bin/ssh",
      args: [
        "-F",
        "/etc/aubtown/ssh/config",
        "--",
        "linux-control-1",
        "/opt/aubtown/node/bin/node",
        "/opt/aubtown/releases/test/probe.js",
        "/etc/aubtown/worker-runtime.json",
        "/opt/aubtown/releases/test/preparer.js",
      ],
    });
  });

  it("rejects a report from another host", async () => {
    await expect(
      probe(new Runner({ ...report, hostId: "macos-executor-1" })).probe(
        "linux-control-1",
      ),
    ).rejects.toThrow("another host identity");
  });
});
