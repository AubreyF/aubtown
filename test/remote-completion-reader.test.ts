import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import type { ExecutionAdmissionBinding } from "../src/adapters/execution-admission.js";
import { assertTrustedCompletionBundle } from "../src/execution/completion-bundle.js";
import {
  trustedCompletionReceiptSchema,
  trustedCompletionReference,
} from "../src/execution/completion-receipt.js";
import {
  executorHandoffManifestDigest,
  executorHandoffManifestFromRequirement,
} from "../src/execution/handoff-manifest.js";
import { SshTrustedCompletionReader } from "../src/execution/remote-completion-reader.js";
import { symphonyWorkspaceRequirementFromBinding } from "../src/integrations/symphony/prepare-admission.js";
import type { SshWorkerPolicyVerifier } from "../src/security/ssh-worker-policy.js";
import { authorityTask, claim, report } from "./helpers.js";

function bundle() {
  const binding: ExecutionAdmissionBinding = {
    qualification: report(),
    authorityTask: authorityTask(),
    claim: claim(),
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
    target: "shared",
  };
  const manifest = executorHandoffManifestFromRequirement(
    symphonyWorkspaceRequirementFromBinding({
      binding,
      requiredAt: "2026-08-13T18:00:00.000Z",
    }),
  );
  const manifestDigest = executorHandoffManifestDigest(manifest);
  const handoff = manifest.binding;
  const receipt = trustedCompletionReceiptSchema.parse({
    schemaVersion: 1,
    kind: "trusted-candidate-finalized",
    manifestDigest,
    repository: handoff.repository,
    issueNumber: handoff.issueNumber,
    claimId: handoff.claimId,
    custodyEpoch: handoff.custodyEpoch,
    hostId: handoff.hostId,
    workerId: handoff.workerId,
    worktree: handoff.worktree,
    branch: handoff.branch,
    authorityTaskId: handoff.handoff.authorityTaskId,
    accountId: handoff.handoff.accountId,
    driverId: handoff.handoff.driverId,
    baseHead: handoff.baseHead,
    head: "b".repeat(40),
    patchDigest: "c".repeat(64),
    finalizationNonce: handoff.handoff.finalizationNonce,
    completedAt: "2026-08-13T18:10:00.000Z",
  });
  return assertTrustedCompletionBundle({
    schemaVersion: 1,
    kind: "trusted-completion-bundle",
    manifestDigest,
    completionReference: trustedCompletionReference(receipt),
    manifest,
    receipt,
  });
}

const policy: SshWorkerPolicyVerifier = {
  verify: async (input) => ({
    hostId: input.hostId,
    hostname: `${input.hostId}.tailnet.example`,
    user: "aubtown-executor",
    identityFile: "/etc/aubtown/ssh/worker_ed25519",
    knownHostsFile: "/etc/aubtown/ssh/known_hosts",
    configSha256: "d".repeat(64),
    sshExecutableSha256: "e".repeat(64),
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

function reader(runner: CommandRunner): SshTrustedCompletionReader {
  return new SshTrustedCompletionReader(
    runner,
    {
      sshExecutable: "/usr/bin/ssh",
      sshConfig: "/etc/aubtown/ssh/config",
      commandCwd: "/var/lib/aubtown/symphony",
      remoteNodeExecutable: "/opt/aubtown/node/bin/node",
      remoteReaderExecutable:
        "/opt/aubtown/releases/test/read-symphony-completion.js",
      remoteRuntimeConfig: "/etc/aubtown/worker-runtime.json",
      expectedUser: "aubtown-executor",
      expectedIdentityFile: "/etc/aubtown/ssh/worker_ed25519",
      expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
    },
    policy,
  );
}

describe("remote trusted completion reader", () => {
  it("reads one exact protected bundle through the enrolled SSH alias", async () => {
    const completed = bundle();
    const runner = new Runner({
      schemaVersion: 1,
      status: "completed",
      bundle: completed,
    });
    await expect(
      reader(runner).read({
        hostId: "linux-control-1",
        manifestDigest: completed.manifestDigest,
      }),
    ).resolves.toEqual(completed);
    expect(runner.request).toMatchObject({
      executable: "/usr/bin/ssh",
      args: [
        "-F",
        "/etc/aubtown/ssh/config",
        "--",
        "linux-control-1",
        "/opt/aubtown/node/bin/node",
        "/opt/aubtown/releases/test/read-symphony-completion.js",
        "/etc/aubtown/worker-runtime.json",
        completed.manifestDigest,
      ],
    });
  });

  it("returns pending and rejects a substituted host", async () => {
    const completed = bundle();
    await expect(
      reader(
        new Runner({
          schemaVersion: 1,
          status: "pending",
          manifestDigest: completed.manifestDigest,
        }),
      ).read({
        hostId: "linux-control-1",
        manifestDigest: completed.manifestDigest,
      }),
    ).resolves.toBeNull();
    await expect(
      reader(
        new Runner({
          schemaVersion: 1,
          status: "completed",
          bundle: {
            ...completed,
            receipt: { ...completed.receipt, hostId: "macos-executor-1" },
          },
        }),
      ).read({
        hostId: "linux-control-1",
        manifestDigest: completed.manifestDigest,
      }),
    ).rejects.toThrow();
  });
});
