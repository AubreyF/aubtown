import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function fixture(relative: string): Promise<string> {
  return await readFile(path.join(root, relative), "utf8");
}

describe("native Linux deployment", () => {
  it("runs one pinned Symphony coordinator without containers or Restate", async () => {
    const unit = await fixture("deploy/systemd/aubtown-symphony.service");
    expect(unit).toContain(
      "/opt/aubtown/symphony/8001b52e3062495a16e520e4ceaf8f9de868c4d0/symphony",
    );
    expect(unit).toContain("/etc/aubtown/WORKFLOW.md");
    expect(unit).toContain("--port 7080");
    expect(unit).toContain("Requires=aubtown-github-token.service");
    expect(unit).not.toMatch(/docker|compose|restate/iu);
  });

  it("refreshes the coordinator token natively before expiry", async () => {
    const service = await fixture("deploy/systemd/aubtown-github-token.service");
    const timer = await fixture("deploy/systemd/aubtown-github-token.timer");
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/cli/refresh-github-token.js");
    expect(service).toContain("UMask=0077");
    expect(service).toContain("ReadWritePaths=/var/lib/aubtown/symphony/secrets");
    expect(timer).toContain("OnUnitActiveSec=35min");
    expect(timer).toContain("RandomizedDelaySec=2min");
    expect(service).not.toMatch(/docker|compose|restate/iu);
  });

  it("keeps coordinator and checkpoint credentials under distinct users", async () => {
    const symphony = await fixture("deploy/systemd/aubtown-symphony.service");
    const checkpoint = await fixture(
      "deploy/systemd/aubtown-checkpoint-edge.service",
    );
    expect(symphony).toContain("User=aubtown-symphony");
    expect(checkpoint).toContain("User=aubtown-checkpoint");
    expect(symphony).not.toContain("CHECKPOINT_RECEIPT_PRIVATE_KEY");
    expect(checkpoint).not.toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("keeps mutable state outside the immutable release tree", async () => {
    const unit = await fixture("deploy/systemd/aubtown-symphony.service");
    expect(unit).toContain("WorkingDirectory=/var/lib/aubtown/symphony");
    expect(unit).toContain("StateDirectory=aubtown/symphony aubtown/workspaces");
    expect(unit).toContain("ReadOnlyPaths=/etc/aubtown");
    expect(unit).toContain("UMask=0077");
    expect(unit).not.toContain("ReadWritePaths=/opt/aubtown");
  });

  it("references GitHub App material by absolute host path", async () => {
    const environment = await fixture("deploy/systemd/symphony.env.example");
    expect(environment).toContain("AUBTOWN_GITHUB_INSTALLATION_ID=");
    expect(environment).toContain("AUBTOWN_GITHUB_APP_ID=");
    expect(environment).toContain(
      "AUBTOWN_GITHUB_APP_PRIVATE_KEY_FILE=/etc/aubtown/keys/github-app-private.pem",
    );
    expect(environment).toContain(
      "GITHUB_TOKEN_FILE=/var/lib/aubtown/symphony/secrets/github.token",
    );
    expect(environment).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/u);
  });

  it("keeps private checkpoint keys on the storage edge", async () => {
    const checkpoint = await fixture("deploy/systemd/checkpoint-edge.env.example");
    expect(checkpoint).toContain("CHECKPOINT_RECEIPT_PRIVATE_KEY_FILE");
    expect(checkpoint).toContain("CHECKPOINT_GRANT_PUBLIC_KEY_FILE");
    expect(checkpoint).not.toContain("CHECKPOINT_GRANT_PRIVATE_KEY_FILE");
  });
});
