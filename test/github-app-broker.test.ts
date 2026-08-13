import { describe, expect, it } from "vitest";
import { GitHubAppBroker } from "../src/credentials/github-app-broker.js";
import type { PublicationPlan } from "../src/publication/policy.js";

const identity = (appId: number) => ({
  appId,
  installationId: appId * 10,
  privateKeyReference: `keyring:github-app-${appId.toLocaleString("en-US", { useGrouping: false })}`,
  selectedRepositories: ["freed-project/freed"],
});

function broker() {
  const calls: Array<{ repositoryName: string; permissions: Record<string, string> }> = [];
  return {
    calls,
    broker: new GitHubAppBroker(
      identity(1),
      identity(2),
      { resolve: async () => "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----" },
      async (input) => {
        calls.push({
          repositoryName: input.repositoryName,
          permissions: { ...input.permissions },
        });
        return {
          type: "token",
          tokenType: "installation",
          token: "installation-token",
          installationId: input.installationId,
          createdAt: "2026-08-13T18:00:00.000Z",
          expiresAt: "2099-08-13T19:00:00.000Z",
          permissions: input.permissions,
          repositorySelection: "selected",
          repositoryNames: [input.repositoryName],
        };
      },
    ),
  };
}

describe("GitHubAppBroker", () => {
  it("mints a repository-scoped read token without worker credentials", async () => {
    const fixture = broker();
    const receipt = await fixture.broker.mintCoordinatorRead("freed-project/freed");
    expect(receipt.repository).toBe("freed-project/freed");
    expect(receipt.permissions.issues).toBe("read");
    expect(fixture.calls[0]?.repositoryName).toBe("freed");
  });

  it("does not mint write projection authority before its phase gate", async () => {
    await expect(
      broker().broker.mintCoordinatorProjection({
        repository: "freed-project/freed",
        projectionApproved: false,
      }),
    ).rejects.toThrow("explicit phase approval");
  });

  it("requires an admitted draft-only plan for publisher credentials", async () => {
    const denied: PublicationPlan = {
      allowed: false,
      action: "none",
      reasons: ["authority-not-proven"],
    };
    await expect(
      broker().broker.mintDraftPublisher({
        repository: "freed-project/freed",
        plan: denied,
      }),
    ).rejects.toThrow("admitted draft publication plan");
  });

  it("rejects repositories outside the selected installation set", async () => {
    await expect(
      broker().broker.mintCoordinatorRead("another/repository"),
    ).rejects.toThrow("not enrolled");
  });
});
