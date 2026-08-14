import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubAppPolicySchema,
  loadGitHubAppPolicy,
  renderGitHubAppRegistration,
} from "../src/config/github-app-registration.js";

const root = process.cwd();

async function registration(role: "coordinator" | "draft-publisher") {
  return renderGitHubAppRegistration(
    await loadGitHubAppPolicy(
      path.join(root, "config", "github-apps", `${role}.json`),
    ),
  );
}

describe("GitHub App registration policy", () => {
  it("renders the exact private Coordinator registration", async () => {
    const rendered = await registration("coordinator");
    const url = new URL(rendered.registrationUrl);

    expect(rendered).toMatchObject({
      role: "coordinator",
      repositorySelection: "selected",
      initialRepositories: ["freed-project/freed"],
      webhookActive: false,
      requestOauthOnInstall: false,
      permissions: {
        metadata: "read",
        contents: "read",
        issues: "write",
        pull_requests: "read",
        checks: "read",
        actions: "read",
      },
    });
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/apps/new",
    );
    expect(url.searchParams.get("public")).toBe("false");
    expect(url.searchParams.get("webhook_active")).toBe("false");
    expect(url.searchParams.get("request_oauth_on_install")).toBe("false");
    expect(url.searchParams.has("events[]")).toBe(false);
    expect(rendered.registrationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("renders the isolated draft-only publisher registration", async () => {
    const rendered = await registration("draft-publisher");
    const url = new URL(rendered.registrationUrl);

    expect(rendered.permissions).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
    });
    for (const forbidden of [
      "actions",
      "administration",
      "deployments",
      "issues",
      "secrets",
      "workflows",
    ]) {
      expect(url.searchParams.has(forbidden)).toBe(false);
    }
    expect(url.searchParams.get("webhook_active")).toBe("false");
    expect(rendered.initialRepositories).toEqual(["freed-project/freed"]);
  });

  it("rejects permission, webhook, OAuth, and publication-ceiling drift", () => {
    const base = {
      schemaVersion: 1,
      name: "AubTown Draft Publisher",
      description: "test",
      homepageUrl: "https://github.com/AubreyF/aubtown",
      repositorySelection: "selected",
      permissions: {
        metadata: "read",
        contents: "write",
        pullRequests: "write",
      },
      events: [],
      public: false,
      webhookActive: false,
      requestOauthOnInstall: false,
      publicationCeiling: "draft-pr",
      workflowFilesAllowed: false,
    };
    for (const changed of [
      { ...base, permissions: { ...base.permissions, actions: "write" } },
      { ...base, webhookActive: true },
      { ...base, requestOauthOnInstall: true },
      { ...base, publicationCeiling: "merge" },
    ]) {
      expect(() => githubAppPolicySchema.parse(changed)).toThrow();
    }
  });
});
