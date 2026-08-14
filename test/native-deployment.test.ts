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

  it("ships a Freed workflow with fail-closed admission and helper-only workspaces", async () => {
    const workflow = await fixture("config/symphony/freed.WORKFLOW.md");
    expect(workflow).toContain("kind: github");
    expect(workflow).toContain('required_labels: [debt, "factory:ready"]');
    expect(workflow).toContain("max_concurrent_agents: 1");
    expect(workflow).toContain("symphony-prelaunch.js");
    expect(workflow).toContain("reject-unprepared-symphony-workspace.js");
    expect(workflow).toContain("verify-symphony-workspace.js");
    expect(workflow).not.toMatch(/docker|compose|restate/iu);
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

  it("runs a loopback-only signed host observation gateway", async () => {
    const service = await fixture(
      "deploy/systemd/aubtown-host-gateway.service",
    );
    const environment = await fixture(
      "deploy/systemd/host-gateway.env.example",
    );
    const symphony = await fixture("deploy/systemd/aubtown-symphony.service");
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/host-gateway.js");
    expect(service).toContain("StateDirectory=aubtown/coordinator");
    expect(environment).toContain("AUBTOWN_BIND_HOST=127.0.0.1");
    expect(environment).toContain("PORT=8090");
    expect(environment).toContain(
      "AUBTOWN_HOST_OBSERVATION_JOURNAL_FILE=/var/lib/aubtown/coordinator/host-observations.json",
    );
    expect(symphony).toContain("Requires=aubtown-github-token.service aubtown-host-gateway.service");
    expect(`${service}\n${environment}`).not.toMatch(/docker|compose|restate/iu);
    const hostAgent = await fixture("deploy/systemd/host-agent.env.example");
    expect(hostAgent).toContain(
      "AUBTOWN_HOST_GATEWAY_URL=http://127.0.0.1:8090",
    );
    expect(hostAgent).toContain("AUBTOWN_QUOTA_SAMPLE_SECONDS=60");
    expect(hostAgent).not.toMatch(/replace-with-private-key|BEGIN PRIVATE KEY/iu);
  });

  it("collects read-only planning evidence every minute without containers", async () => {
    const service = await fixture(
      "deploy/systemd/aubtown-planning-snapshot.service",
    );
    const timer = await fixture(
      "deploy/systemd/aubtown-planning-snapshot.timer",
    );
    const environment = await fixture("deploy/systemd/symphony.env.example");
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/cli/collect-planning-snapshot.js");
    expect(service).toContain("ReadOnlyPaths=/etc/aubtown /srv/freed /var/lib/freed/automation");
    expect(service).toContain("ReadWritePaths=/var/lib/aubtown/coordinator");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(environment).toContain(
      "AUBTOWN_PLANNING_SNAPSHOT_FILE=/var/lib/aubtown/coordinator/planning-snapshot.json",
    );
    expect(environment).toContain(
      "AUBTOWN_DISPATCH_INTENTION_FILE=/var/lib/aubtown/coordinator/dispatch-intention.json",
    );
    expect(environment).toContain(
      "AUBTOWN_ACCOUNT_PROFILES_FILE=/etc/aubtown/account-profiles.json",
    );
    expect(environment).toContain(
      "AUBTOWN_HOST_WORKSPACE_ROOTS_FILE=/etc/aubtown/host-workspaces.json",
    );
    expect(environment).toContain("AUBTOWN_PILOT_ISSUE_NUMBER=");
    expect(`${service}\n${timer}`).not.toMatch(/docker|compose|restate/iu);
  });

  it("ships a native non-authoritative admission candidate publisher", async () => {
    const packageJson = await fixture("package.json");
    const publisher = await fixture(
      "src/cli/publish-symphony-candidate.ts",
    );
    expect(packageJson).toContain('"symphony:publish-candidate"');
    expect(packageJson).toContain('"symphony:reconcile-candidate"');
    expect(publisher).toContain("AUBTOWN_PRELAUNCH_CANDIDATE_ROOT");
    expect(publisher).toContain("publishSymphonyAdmissionCandidateFile");
    expect(publisher).not.toContain("FreedAuthorityBridge");
    const reconciler = await fixture(
      "src/cli/reconcile-symphony-candidate.ts",
    );
    expect(reconciler).toContain("publishReconciledAdmissionCandidateFile");
    expect(reconciler).not.toContain("FreedAuthorityBridge");
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
    expect(unit).toContain(
      "StateDirectory=aubtown/symphony aubtown/workspaces aubtown/admission",
    );
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
    expect(environment).toContain(
      "AUBTOWN_PRELAUNCH_CANDIDATE_ROOT=/var/lib/aubtown/admission/candidates",
    );
    expect(environment).toContain(
      "AUBTOWN_PRELAUNCH_ENVELOPE_ROOT=/var/lib/aubtown/admission/envelopes",
    );
    expect(environment).toContain(
      "AUBTOWN_PRELAUNCH_RECEIPT_ROOT=/var/lib/aubtown/admission/receipts",
    );
    expect(environment).toContain(
      "AUBTOWN_FREED_CLAIM_BROKER=/opt/freed/bin/factory-coordinator",
    );
    expect(environment).toContain(
      "AUBTOWN_FREED_REPOSITORY_ROOT=/srv/freed",
    );
    expect(environment).toContain(
      "AUBTOWN_FREED_STATE_ROOT=/var/lib/freed/automation",
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
