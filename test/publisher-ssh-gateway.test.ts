import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/adapters/command-runner.js";
import type { DraftPublicationReceipt } from "../src/publication/draft-publisher.js";
import type { PublisherReadinessReport } from "../src/publication/publisher-readiness.js";
import { runPublisherSshGateway } from "../src/publication/publisher-ssh-gateway.js";

const runner: CommandRunner = {
  run: async () => ({ stdout: "", stderr: "" }),
};

const readiness: PublisherReadinessReport = {
  schemaVersion: 1,
  hostId: "linux-control-1",
  checkedAt: "2026-08-14T14:00:00.000Z",
  ready: true,
  runtime: { path: "/etc/aubtown/publisher-runtime.json", sha256: "1".repeat(64) },
  authorizedKeys: {
    path: "/etc/aubtown/ssh/publisher_authorized_keys",
    sha256: "4".repeat(64),
  },
  gateway: { path: "/opt/aubtown/gateway.js", sha256: "2".repeat(64) },
  publisher: { path: "/opt/aubtown/publisher.js", sha256: "3".repeat(64) },
  git: { executable: "/usr/bin/git", version: "git version 2.50.1" },
  node: { executable: "/opt/aubtown/node/bin/node", version: "v24.14.1" },
  privateKey: { path: "/etc/aubtown/publisher/key.pem", ownerUid: 997, mode: "0600" },
  selectedRepositories: ["freed-project/freed"],
  worktreeRoots: ["/var/lib/aubtown/workspaces"],
};

const receipt: DraftPublicationReceipt = {
  schemaVersion: 1,
  repository: "freed-project/freed",
  checkpointReference: "a".repeat(64),
  branch: "fix/example",
  head: "b".repeat(40),
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/freed-project/freed/pull/42",
  draft: true,
  publishedAt: "2026-08-14T14:00:00.000Z",
  tokenExpiresAt: "2026-08-14T15:00:00.000Z",
};

function input(originalCommand: string | undefined) {
  return {
    originalCommand,
    runtimeFile: "/etc/aubtown/publisher-runtime.json",
    publisherFile: "/opt/aubtown/publisher.js",
    gatewayFile: "/opt/aubtown/gateway.js",
    authorizedKeysFile: "/etc/aubtown/ssh/publisher_authorized_keys",
    runner,
    checkedAt: "2026-08-14T14:00:00.000Z",
  } as const;
}

describe("publisher SSH forced-command gateway", () => {
  it("admits only the readiness probe", async () => {
    const probe = vi.fn(async () => readiness);
    const publish = vi.fn(async () => receipt);

    await expect(
      runPublisherSshGateway({ ...input("probe"), probe, publish }),
    ).resolves.toEqual(readiness);
    expect(probe).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rechecks protected readiness before one admitted publication", async () => {
    const probe = vi.fn(async () => readiness);
    const publish = vi.fn(async () => receipt);
    const payload = Buffer.from('{"allowed":true}').toString("base64url");

    await expect(
      runPublisherSshGateway({
        ...input(`publish ${payload}`),
        probe,
        publish,
      }),
    ).resolves.toEqual(receipt);
    expect(probe).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      runtimeFile: "/etc/aubtown/publisher-runtime.json",
      payload,
      runner,
    });
  });

  it.each([
    undefined,
    "",
    "publish",
    "publish  payload",
    "publish payload; id",
    "/bin/sh -c id",
    "probe extra",
  ])("rejects command outside the two-operation allowlist: %s", async (command) => {
    const probe = vi.fn(async () => readiness);
    const publish = vi.fn(async () => receipt);

    await expect(
      runPublisherSshGateway({ ...input(command), probe, publish }),
    ).rejects.toThrow("outside the forced-command allowlist");
    expect(probe).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish when the protected runtime probe fails", async () => {
    const probe = vi.fn(async () => {
      throw new Error("gateway digest changed");
    });
    const publish = vi.fn(async () => receipt);

    await expect(
      runPublisherSshGateway({ ...input("publish cGF5bG9hZA"), probe, publish }),
    ).rejects.toThrow("gateway digest changed");
    expect(publish).not.toHaveBeenCalled();
  });
});
