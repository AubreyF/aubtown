import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();

describe("Symphony upstream contract", () => {
  it("pins production while tracking upstream main separately", async () => {
    const lock = JSON.parse(
      await readFile(path.join(root, "upstream/symphony.lock.json"), "utf8"),
    ) as {
      production: { commit: string; sourceArchive: string; sourceSha256: string };
      tracking: { ref: string };
      reviewedCapabilities: string[];
      knownGaps: string[];
      patches: Array<{
        path: string;
        sha256: string;
        verifiedAgainst: string;
        purpose: string[];
      }>;
    };
    expect(lock.production.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(lock.production.sourceArchive).toContain(lock.production.commit);
    expect(lock.production.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(lock.tracking.ref).toBe("refs/heads/main");
    expect(lock.reviewedCapabilities).toContain("github-issues-adapter");
    expect(lock.reviewedCapabilities).toContain("ssh-workers");
    expect(lock.reviewedCapabilities).toContain(
      "capability-aware-ssh-worker-routing",
    );
    expect(lock.reviewedCapabilities).toContain(
      "fail-closed-prelaunch-admission-command",
    );
    expect(lock.reviewedCapabilities).toContain(
      "fail-closed-active-turn-guard",
    );
    expect(lock.reviewedCapabilities).toContain(
      "fail-closed-trusted-completion-hook",
    );
    expect(lock.knownGaps).not.toContain(
      "worker-host-selection-is-load-based-not-lane-aware",
    );
    expect(lock.patches).toHaveLength(4);
    for (const patch of lock.patches) {
      expect(patch.verifiedAgainst).toBe(lock.production.commit);
      const patchBytes = await readFile(path.join(root, patch.path));
      expect(createHash("sha256").update(patchBytes).digest("hex")).toBe(
        patch.sha256,
      );
    }
    const runtimePatch = await readFile(path.join(root, lock.patches[0]!.path));
    const activeGuardPatch = await readFile(path.join(root, lock.patches[1]!.path));
    const completionPatch = await readFile(path.join(root, lock.patches[2]!.path));
    const dependencyPatch = await readFile(path.join(root, lock.patches[3]!.path));
    expect(runtimePatch.toString("utf8")).toContain(
      "select_worker_host_for_issue_for_test",
    );
    expect(runtimePatch.toString("utf8")).toContain(
      "Prelaunch admission failed closed",
    );
    expect(runtimePatch.toString("utf8")).toContain(
      "less_than_or_equal_to: 900_000",
    );
    expect(runtimePatch.toString("utf8")).toContain("GITHUB_TOKEN_FILE");
    expect(runtimePatch.toString("utf8")).not.toContain(
      "No retired or security advisory packages found",
    );
    expect(activeGuardPatch.toString("utf8")).toContain("turn/interrupt");
    expect(activeGuardPatch.toString("utf8")).toContain(
      "active_guard_hard_stop",
    );
    expect(completionPatch.toString("utf8")).toContain(
      "Workspace.run_completion_hook",
    );
    expect(completionPatch.toString("utf8")).toContain(
      "trusted completion hook propagates failure",
    );
    expect(dependencyPatch.toString("utf8")).toContain(
      '+  "bandit": {:hex, :bandit, "1.12.5"',
    );
    expect(dependencyPatch.toString("utf8")).not.toContain(
      '+  "bandit": {:hex, :bandit, "1.12.4"',
    );
  });

  it("validates the lock without requiring network access", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(root, "scripts/check-symphony-upstream.mjs")],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      status: "lock-valid",
      productionCommit: "8001b52e3062495a16e520e4ceaf8f9de868c4d0",
      releaseBaseline: "v0.0.2",
    });
  });
});
