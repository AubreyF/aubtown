import { execFile } from "node:child_process";
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
    };
    expect(lock.production.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(lock.production.sourceArchive).toContain(lock.production.commit);
    expect(lock.production.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(lock.tracking.ref).toBe("refs/heads/main");
    expect(lock.reviewedCapabilities).toContain("github-issues-adapter");
    expect(lock.reviewedCapabilities).toContain("ssh-workers");
    expect(lock.knownGaps).toContain(
      "worker-host-selection-is-load-based-not-lane-aware",
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
