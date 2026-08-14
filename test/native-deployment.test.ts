import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function fixture(relative: string): Promise<string> {
  return await readFile(path.join(root, relative), "utf8");
}

describe("native Linux deployment", () => {
  it("validates every change on Linux and macOS without write authority", async () => {
    const workflow = await fixture(".github/workflows/validation.yml");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toContain("go-version-file: go.mod");
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm run check:symphony");
    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/uses: actions\/setup-node@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/uses: actions\/setup-go@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/secrets\.|contents: write|pull-requests: write/u);
  });

  it("builds one clean manifest-bound host release", async () => {
    const packageJson = await fixture("package.json");
    const cleaner = await fixture("scripts/clean-dist.mjs");
    const release = await fixture("src/deployment/release-manifest.ts");
    const builder = await fixture("src/cli/build-release-bundle.ts");
    const verifier = await fixture("src/cli/verify-release-install.ts");
    const readiness = await fixture("src/pilot/readiness.ts");

    expect(packageJson).toContain(
      '"build": "node scripts/clean-dist.mjs && tsc',
    );
    expect(packageJson).toContain('"release:bundle"');
    expect(packageJson).toContain('"release:verify-install"');
    expect(cleaner).toContain('path.basename(target) !== "dist"');
    expect(release).toContain('"--omit=dev"');
    expect(release).toContain('"--ignore-scripts"');
    expect(release).toContain("Release contains a symbolic link");
    expect(release).toContain("Release file differs from its manifest");
    expect(builder).toContain("buildReleaseBundle");
    expect(verifier).toContain("requiredUid: 0");
    expect(readiness).toContain('check("runtime:release-manifest"');
    expect(readiness).toContain("verifyInstalledRelease");
  });

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
    expect(workflow).toContain("timeout_ms: 60000");
    expect(workflow).toContain("symphony-active-run-guard.js");
    expect(workflow).toContain("interrupt_grace_ms: 5000");
    expect(workflow).toContain("reject-unprepared-symphony-workspace.js");
    expect(workflow).toContain("verify-symphony-workspace.js");
    expect(workflow).toContain("complete-symphony-workspace.js");
    expect(workflow).toContain("linux-control-1");
    expect(workflow).toContain("macos-executor-1");
    expect(workflow).not.toMatch(/docker|compose|restate/iu);
  });

  it("prepares exact Freed worktrees over the existing Symphony SSH lane", async () => {
    const environment = await fixture("deploy/systemd/symphony.env.example");
    const runtime = JSON.parse(
      await fixture("config/hosts/worker-runtime.example.json"),
    ) as Record<string, unknown>;
    const macRuntime = JSON.parse(
      await fixture("config/hosts/worker-runtime.macos.example.json"),
    ) as Record<string, unknown>;
    const reviewerRuntime = JSON.parse(
      await fixture("config/hosts/reviewer-runtime.example.json"),
    ) as Record<string, unknown>;
    const macReviewerRuntime = JSON.parse(
      await fixture("config/hosts/reviewer-runtime.macos.example.json"),
    ) as Record<string, unknown>;
    const publisherRuntime = JSON.parse(
      await fixture("config/hosts/publisher-runtime.example.json"),
    ) as Record<string, unknown>;
    const macPublisherRuntime = JSON.parse(
      await fixture("config/hosts/publisher-runtime.macos.example.json"),
    ) as Record<string, unknown>;
    expect(environment).toContain("AUBTOWN_SSH_EXECUTABLE=/usr/bin/ssh");
    expect(environment).toContain("prepare-symphony-workspace.js");
    expect(environment).toContain("complete-symphony-workspace.js");
    expect(environment).toContain("read-symphony-completion.js");
    expect(environment).toContain("adjudicate-symphony-completion.js");
    expect(environment).toContain("AUBTOWN_REMOTE_WORKER_RUNTIME_CONFIG=");
    expect(environment).not.toContain("AUBTOWN_REMOTE_PUBLISHER_RUNTIME_CONFIG=");
    expect(runtime).toMatchObject({
      hostId: "linux-control-1",
      repository: {
        owner: "freed-project",
        name: "freed",
        defaultBranch: "dev",
      },
      handoffRoot: "/var/lib/aubtown/executor/handoffs",
      worktreeHelper: "/srv/freed/repository/scripts/worktree-add.sh",
    });
    expect(macRuntime).toMatchObject({
      hostId: "macos-executor-1",
      repository: {
        owner: "freed-project",
        name: "freed",
        defaultBranch: "dev",
      },
      handoffRoot:
        "/Users/aubtown/Library/Application Support/AubTown/executor/handoffs",
      worktreeHelper: "/Users/aubtown/freed/scripts/worktree-add.sh",
    });
    expect(reviewerRuntime).toMatchObject({
      hostId: "linux-control-1",
      accountId: "codex-pro-1",
      quotaSampleIntervalMs: 30_000,
    });
    expect(macReviewerRuntime).toMatchObject({
      hostId: "macos-executor-1",
      accountId: "codex-pro-1",
      quotaSampleIntervalMs: 30_000,
    });
    expect(publisherRuntime).toMatchObject({
      hostId: "linux-control-1",
      nodeVersion: "v24.14.1",
      selectedRepositories: ["freed-project/freed"],
      worktreeRoots: ["/var/lib/aubtown/workspaces"],
    });
    expect(macPublisherRuntime).toMatchObject({
      hostId: "macos-executor-1",
      nodeVersion: "v24.14.1",
      selectedRepositories: ["freed-project/freed"],
      worktreeRoots: [
        "/Users/aubtown/Library/Application Support/AubTown/workspaces",
      ],
    });
    expect(await fixture("package.json")).toContain(
      '"symphony:publish-draft-local"',
    );
    expect(await fixture("package.json")).toContain(
      '"publisher:ssh-gateway"',
    );
  });

  it("reconciles trusted completion downstream of Symphony without another scheduler", async () => {
    const service = await fixture(
      "deploy/systemd/aubtown-completion-reconciliation.service",
    );
    const timer = await fixture(
      "deploy/systemd/aubtown-completion-reconciliation.timer",
    );
    const environment = await fixture("deploy/systemd/symphony.env.example");
    const command = await fixture(
      "src/cli/reconcile-symphony-completion.ts",
    );
    const packageJson = await fixture("package.json");
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/cli/reconcile-symphony-completion.js");
    expect(service).toContain("ReadWritePaths=/var/lib/aubtown/admission");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(environment).toContain("AUBTOWN_ACTIVE_TURN_ROOT=");
    expect(environment).toContain("AUBTOWN_COMPLETION_RECONCILIATION_ROOT=");
    expect(environment).toContain("AUBTOWN_VALIDATION_PROFILE_FILE=");
    expect(environment).toContain("AUBTOWN_REMOTE_ADJUDICATOR=");
    expect(environment).toContain("AUBTOWN_REMOTE_REVIEWER_RUNTIME_CONFIG=");
    expect(environment).toContain("AUBTOWN_TRUSTED_ADJUDICATION_ROOT=");
    expect(environment).toContain("AUBTOWN_PUBLICATION_TRANSACTION_ROOT=");
    expect(environment).toContain("AUBTOWN_SSH_PUBLISHER_USER=aubtown-publisher");
    expect(environment).toContain(
      "AUBTOWN_SSH_PUBLISHER_IDENTITY_FILE=/etc/aubtown/ssh/publisher_ed25519",
    );
    expect(environment).toContain(
      "AUBTOWN_GITHUB_MACHINE_AUTHOR_LOGIN=",
    );
    expect(environment).toContain(
      "AUBTOWN_LIFECYCLE_PROJECTION_ENABLED=false",
    );
    expect(command).toContain("SymphonyCompletionReconciler");
    expect(command).toContain("SshAdjudicationRunner");
    expect(command).toContain("TrustedAdjudicationResultStore");
    expect(command).toContain("DurablePublicationCoordinator");
    expect(command).toContain("PublicationTransactionStore");
    expect(command).toContain("SshDraftPublisher");
    expect(command).toContain("GitHubProjectionWriter");
    expect(command).toContain("BlockedHandoffCoordinator");
    expect(command).toContain("GitHubLivePlanningReader");
    expect(command).toContain("FreedAuthorityBridge");
    expect(packageJson).toContain('"symphony:adjudicate-completion"');
    expect(`${service}\n${timer}\n${command}`).not.toMatch(
      /docker|compose|restate/iu,
    );
  });

  it("ships a noninteractive pinned-host SSH worker profile", async () => {
    const config = await fixture("config/hosts/ssh_config.example");
    const linuxPublisherKey = await fixture(
      "config/hosts/publisher_authorized_keys.example",
    );
    const macPublisherKey = await fixture(
      "config/hosts/publisher_authorized_keys.macos.example",
    );
    const linuxSshd = await fixture(
      "deploy/sshd/aubtown-publisher.conf.example",
    );
    const macSshd = await fixture(
      "deploy/sshd/aubtown-publisher.macos.conf.example",
    );
    for (const required of [
      "Host linux-control-1 macos-executor-1",
      "User aubtown-executor",
      "IdentityFile /etc/aubtown/ssh/worker_ed25519",
      "UserKnownHostsFile /etc/aubtown/ssh/known_hosts",
      "GlobalKnownHostsFile /dev/null",
      "BatchMode yes",
      "StrictHostKeyChecking yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PreferredAuthentications publickey",
      "GSSAPIAuthentication no",
      "HostbasedAuthentication no",
      "ForwardAgent no",
      "ClearAllForwardings yes",
      "ControlMaster no",
      "UpdateHostKeys no",
    ]) {
      expect(config).toContain(required);
    }
    for (const authorizedKey of [linuxPublisherKey, macPublisherKey]) {
      expect(authorizedKey).toContain("restrict,command=");
      expect(authorizedKey).toContain("publisher-ssh-gateway.js");
      expect(authorizedKey).toContain("publish-draft-local.js");
      expect(authorizedKey).toContain("publisher_authorized_keys");
      expect(authorizedKey).toContain("ssh-ed25519");
      expect(authorizedKey).not.toMatch(/\b(?:bash|sh|zsh)\b/u);
    }
    expect(linuxPublisherKey).toContain("/etc/aubtown/publisher-runtime.json");
    expect(macPublisherKey).toContain(
      "'/Library/Application Support/AubTown/publisher-runtime.json'",
    );
    for (const sshd of [linuxSshd, macSshd]) {
      expect(sshd).toContain("Match User aubtown-publisher");
      expect(sshd).toContain("AuthenticationMethods publickey");
      expect(sshd).toContain("ForceCommand");
      expect(sshd).toContain("publisher-ssh-gateway.js");
      expect(sshd).toContain("DisableForwarding yes");
      expect(sshd).toContain("PermitTTY no");
      expect(sshd).toContain("PasswordAuthentication no");
      expect(sshd).toContain("KbdInteractiveAuthentication no");
    }
    expect(config).toContain("HostKeyAlias linux-control-1");
    expect(config).toContain("HostKeyAlias macos-executor-1");
    for (const required of [
      "Host linux-control-1-publisher macos-executor-1-publisher",
      "User aubtown-publisher",
      "IdentityFile /etc/aubtown/ssh/publisher_ed25519",
      "HostKeyAlias linux-control-1-publisher",
      "HostKeyAlias macos-executor-1-publisher",
    ]) {
      expect(config).toContain(required);
    }
  });

  it("refreshes the coordinator token natively before expiry", async () => {
    const service = await fixture(
      "deploy/systemd/aubtown-github-token.service",
    );
    const timer = await fixture("deploy/systemd/aubtown-github-token.timer");
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/cli/refresh-github-token.js");
    expect(service).toContain("UMask=0077");
    expect(service).toContain(
      "ReadWritePaths=/var/lib/aubtown/symphony/secrets",
    );
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
    expect(symphony).toContain(
      "Requires=aubtown-github-token.service aubtown-host-gateway.service",
    );
    expect(`${service}\n${environment}`).not.toMatch(
      /docker|compose|restate/iu,
    );
    const hostAgent = await fixture("deploy/systemd/host-agent.env.example");
    expect(hostAgent).toContain(
      "AUBTOWN_HOST_GATEWAY_URL=http://127.0.0.1:8090",
    );
    expect(hostAgent).toContain("AUBTOWN_QUOTA_SAMPLE_SECONDS=60");
    expect(hostAgent).not.toMatch(
      /EXECUTION_JOURNAL|ADJUDICATION_JOURNAL|CHECKPOINT|WORKTREE/iu,
    );
    expect(hostAgent).not.toMatch(
      /replace-with-private-key|BEGIN PRIVATE KEY/iu,
    );
  });

  it("deploys telemetry without a second worker scheduler", async () => {
    const service = await fixture("deploy/systemd/aubtown-host-agent.service");
    const monitor = await fixture("src/host-monitor.ts");
    const launchd = await fixture("deploy/launchd/aubtown.host-agent.plist");
    expect(service).toContain("dist/host-monitor.js");
    expect(service).not.toContain("dist/host-agent.js");
    expect(launchd).toContain("dist/host-monitor.js");
    expect(monitor).toContain("CodexQuotaSource");
    expect(monitor).toContain("host-telemetry-sampled");
    expect(monitor).not.toMatch(
      /HostExecutionSupervisor|HostWorkspaceSupervisor|pollExecutor|worker\.start/iu,
    );
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
    expect(service).toContain(
      "ReadOnlyPaths=/etc/aubtown /srv/freed /var/lib/freed/automation",
    );
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

  it("heartbeats active claims and reconciles stale custody without containers", async () => {
    const symphony = await fixture("deploy/systemd/aubtown-symphony.service");
    const service = await fixture(
      "deploy/systemd/aubtown-claim-reconciliation.service",
    );
    const timer = await fixture(
      "deploy/systemd/aubtown-claim-reconciliation.timer",
    );
    const environment = await fixture("deploy/systemd/symphony.env.example");
    const activeGuard = await fixture("src/cli/symphony-active-run-guard.ts");
    expect(symphony).toContain(
      "dist/cli/reconcile-freed-claims.js --require-clear",
    );
    expect(service).toContain("User=aubtown-symphony");
    expect(service).toContain("dist/cli/reconcile-freed-claims.js");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(environment).toContain(
      "AUBTOWN_CLAIM_RECONCILIATION_FILE=/var/lib/aubtown/admission/claim-reconciliation.json",
    );
    expect(activeGuard).toContain("heartbeatSymphonyActiveClaim");
    expect(`${symphony}\n${service}\n${timer}`).not.toMatch(
      /docker|compose|restate/iu,
    );
  });

  it("ships a fail-closed native pilot readiness audit", async () => {
    const service = await fixture(
      "deploy/systemd/aubtown-pilot-readiness.service",
    );
    const environment = await fixture("deploy/systemd/symphony.env.example");
    const packageJson = await fixture("package.json");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("dist/cli/audit-pilot-readiness.js");
    expect(service).toContain("dist/cli/probe-executor-readiness.js");
    expect(service).toContain("dist/cli/probe-publisher-readiness.js");
    expect(service).toContain(
      "Requires=aubtown-github-token.service aubtown-host-gateway.service aubtown-planning-snapshot.service",
    );
    expect(service).toContain(
      "ReadOnlyPaths=/etc/aubtown /opt/aubtown /opt/freed /srv/freed /var/lib/freed/automation",
    );
    expect(service).toContain("ReadWritePaths=/var/lib/aubtown/coordinator");
    expect(service).toContain(
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    );
    expect(environment).toContain("AUBTOWN_PILOT_READINESS_FILE=");
    expect(environment).toContain("AUBTOWN_EXECUTOR_READINESS_FILE=");
    expect(environment).toContain("AUBTOWN_PUBLISHER_READINESS_FILE=");
    expect(environment).toContain("AUBTOWN_REMOTE_EXECUTOR_PROBE=");
    expect(environment).not.toContain("AUBTOWN_REMOTE_PUBLISHER_PROBE=");
    expect(environment).toContain("AUBTOWN_SYMPHONY_LOCK_FILE=");
    expect(environment).toContain("AUBTOWN_SYMPHONY_EXECUTABLE=");
    expect(packageJson).toContain('"pilot:audit"');
    expect(packageJson).toContain('"pilot:probe-executor"');
    expect(packageJson).toContain('"pilot:probe-publisher"');
    expect(packageJson).toContain('"publisher:ssh-gateway"');
    expect(`${service}\n${environment}`).not.toMatch(
      /docker|compose|restate/iu,
    );
  });

  it("requires a disposable broker conformance proof before pilot readiness", async () => {
    const conformance = await fixture(
      "deploy/systemd/aubtown-freed-broker-conformance.service",
    );
    const readiness = await fixture(
      "deploy/systemd/aubtown-pilot-readiness.service",
    );
    const environment = await fixture("deploy/systemd/symphony.env.example");
    const packageJson = await fixture("package.json");
    expect(conformance).toContain("dist/cli/verify-freed-broker.js");
    expect(conformance).toContain("/etc/aubtown/freed-broker-conformance.json");
    expect(conformance).toContain(
      "ReadWritePaths=/var/lib/aubtown/coordinator /var/lib/aubtown/conformance",
    );
    expect(readiness).toContain("aubtown-freed-broker-conformance.service");
    expect(environment).toContain(
      "AUBTOWN_FREED_BROKER_CONFORMANCE_FILE=/var/lib/aubtown/coordinator/freed-broker-conformance.json",
    );
    expect(packageJson).toContain('"freed:broker-conformance"');
    expect(conformance).not.toMatch(/docker|compose|restate/iu);
  });

  it("ships a native non-authoritative admission candidate publisher", async () => {
    const packageJson = await fixture("package.json");
    const publisher = await fixture("src/cli/publish-symphony-candidate.ts");
    expect(packageJson).toContain('"symphony:publish-candidate"');
    expect(packageJson).toContain('"symphony:reconcile-candidate"');
    expect(publisher).toContain("AUBTOWN_PRELAUNCH_CANDIDATE_ROOT");
    expect(publisher).toContain("publishSymphonyAdmissionCandidateFile");
    expect(publisher).not.toContain("FreedAuthorityBridge");
    const reconciler = await fixture("src/cli/reconcile-symphony-candidate.ts");
    expect(reconciler).toContain("publishReconciledAdmissionCandidateFile");
    expect(reconciler).not.toContain("FreedAuthorityBridge");
  });

  it("ships a non-authoritative checkpoint-backed custody planner", async () => {
    const packageJson = await fixture("package.json");
    const planner = await fixture("src/cli/plan-custody-transfer.ts");
    const environment = await fixture("deploy/systemd/symphony.env.example");
    expect(packageJson).toContain('"custody:plan"');
    expect(planner).toContain("parseCustodyTransferPlanningInput");
    expect(planner).toContain("planCustodyTransfer");
    expect(planner).toContain("writeProtectedJsonFile");
    expect(environment).toContain("AUBTOWN_CUSTODY_TRANSFER_PLAN_FILE=");
    expect(planner).not.toContain("claim-transfer");
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
    expect(environment).toContain("AUBTOWN_FREED_REPOSITORY_ROOT=/srv/freed");
    expect(environment).toContain(
      "AUBTOWN_FREED_STATE_ROOT=/var/lib/freed/automation",
    );
    expect(environment).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/u);
  });

  it("keeps private checkpoint keys on the storage edge", async () => {
    const checkpoint = await fixture(
      "deploy/systemd/checkpoint-edge.env.example",
    );
    expect(checkpoint).toContain("CHECKPOINT_RECEIPT_PRIVATE_KEY_FILE");
    expect(checkpoint).toContain("CHECKPOINT_GRANT_PUBLIC_KEY_FILE");
    expect(checkpoint).not.toContain("CHECKPOINT_GRANT_PRIVATE_KEY_FILE");
  });
});
