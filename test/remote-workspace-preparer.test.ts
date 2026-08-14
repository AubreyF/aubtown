import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { SshInitialWorkspacePreparer } from "../src/execution/remote-workspace-preparer.js";
import {
  initialWorkspaceRequirementSchema,
  type InitialWorkspaceReceipt,
} from "../src/execution/workspace.js";

const requirement = initialWorkspaceRequirementSchema.parse({
  schemaVersion: 1,
  repository: {
    owner: "freed-project",
    name: "freed",
    defaultBranch: "dev",
  },
  issueNumber: 1_234,
  claimId: "claim-1234",
  custodyEpoch: 1,
  hostId: "linux-control-1",
  workerId: "worker-linux-control-1",
  worktree: "/var/lib/aubtown/workspaces/GH-1234",
  branch: "fix/issue-1234",
  conflictDomains: ["runtime-neutral"],
  claimedAt: "2026-08-13T18:00:00.000Z",
  baseHead: "a".repeat(40),
  target: "shared",
  requiredAt: "2026-08-13T18:00:01.000Z",
});

class CapturingRunner implements CommandRunner {
  request?: CommandRequest;

  constructor(private readonly receipt: InitialWorkspaceReceipt) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.request = request;
    return { stdout: `${JSON.stringify(this.receipt)}\n`, stderr: "" };
  }
}

function receipt(
  overrides: Partial<InitialWorkspaceReceipt> = {},
): InitialWorkspaceReceipt {
  return {
    schemaVersion: 1,
    claimId: requirement.claimId,
    custodyEpoch: 1,
    hostId: requirement.hostId,
    worktree: requirement.worktree,
    branch: requirement.branch,
    baseHead: requirement.baseHead,
    preparedAt: "2026-08-13T18:00:02.000Z",
    ...overrides,
  };
}

function preparer(runner: CommandRunner): SshInitialWorkspacePreparer {
  return new SshInitialWorkspacePreparer(runner, {
    sshExecutable: "/usr/bin/ssh",
    sshConfig: "/etc/aubtown/ssh/config",
    commandCwd: "/var/lib/aubtown/symphony",
    remoteNodeExecutable: "/opt/aubtown/node/bin/node",
    remotePreparerExecutable:
      "/opt/aubtown/current/dist/cli/prepare-symphony-workspace.js",
    remoteRuntimeConfig: "/etc/aubtown/worker-runtime.json",
  });
}

describe("remote initial workspace preparation", () => {
  it("sends one exact encoded requirement to the selected SSH host", async () => {
    const runner = new CapturingRunner(receipt());
    await expect(preparer(runner).prepare(requirement)).resolves.toEqual(receipt());
    expect(runner.request).toMatchObject({
      executable: "/usr/bin/ssh",
      cwd: "/var/lib/aubtown/symphony",
      args: [
        "-F",
        "/etc/aubtown/ssh/config",
        "--",
        "linux-control-1",
        "/opt/aubtown/node/bin/node",
        "/opt/aubtown/current/dist/cli/prepare-symphony-workspace.js",
        "/etc/aubtown/worker-runtime.json",
        expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      ],
    });
    const encoded = runner.request?.args.at(-1);
    expect(
      initialWorkspaceRequirementSchema.parse(
        JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")),
      ),
    ).toEqual(requirement);
  });

  it("rejects a receipt for another worktree or claim", async () => {
    await expect(
      preparer(
        new CapturingRunner(receipt({ worktree: "/tmp/foreign-worktree" })),
      ).prepare(requirement),
    ).rejects.toThrow("does not match the admitted claim");
  });

  it("rejects remote command paths that require shell interpretation", () => {
    expect(
      () =>
        new SshInitialWorkspacePreparer(new CapturingRunner(receipt()), {
          sshExecutable: "/usr/bin/ssh",
          sshConfig: "/etc/aubtown/ssh/config",
          commandCwd: "/var/lib/aubtown/symphony",
          remoteNodeExecutable: "/opt/aubtown/node;shutdown",
          remotePreparerExecutable: "/opt/aubtown/preparer.js",
          remoteRuntimeConfig: "/etc/aubtown/worker.json",
        }),
    ).toThrow("shell-safe absolute path");
  });
});
