import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { qualificationReportSchema } from "../src/domain/schemas.js";
import { ExecutorHandoffManifestStore } from "../src/execution/handoff-manifest.js";
import {
  createWorkspaceFinalizationNonce,
  initialWorkspaceRequirementSchema,
  type InitialWorkspaceRequirement,
} from "../src/execution/workspace.js";
import { report } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly worktree: string;
  readonly handoffRoot: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(await realpath(os.tmpdir()), "aubtown-handoff-")),
  );
  roots.push(root);
  const worktree = path.join(root, "worktrees", "GH-1234");
  const handoffRoot = path.join(root, "handoffs");
  await mkdir(worktree, { recursive: true });
  return { root, worktree, handoffRoot };
}

function requirement(
  worktree: string,
  overrides: {
    readonly requiredAt?: string;
    readonly finalizationNonce?: string;
  } = {},
): InitialWorkspaceRequirement {
  const qualification = qualificationReportSchema.parse(report());
  const input = {
    repository: qualification.repository,
    issueNumber: qualification.issue.number,
    claimId: "claim-1234",
    custodyEpoch: 1 as const,
    hostId: "linux-control-1",
    workerId: "worker-linux-control-1",
    worktree,
    branch: "fix/deterministic-validation",
    authorityTaskId: "github-issue-1234",
    authorityTaskRevision: 1,
    accountId: "codex-pro-1",
    driverId: "codex-app-server-v1",
    baseHead: "a".repeat(40),
  };
  return initialWorkspaceRequirementSchema.parse({
    schemaVersion: 1,
    repository: input.repository,
    issueNumber: input.issueNumber,
    claimId: input.claimId,
    custodyEpoch: input.custodyEpoch,
    hostId: input.hostId,
    workerId: input.workerId,
    worktree: input.worktree,
    branch: input.branch,
    conflictDomains: qualification.conflictDomains,
    claimedAt: "2026-08-13T18:00:00.000Z",
    baseHead: input.baseHead,
    target: "shared",
    handoff: {
      qualification,
      authorityTaskId: input.authorityTaskId,
      authorityTaskRevision: input.authorityTaskRevision,
      accountId: input.accountId,
      driverId: input.driverId,
      publicationCeiling: "draft-pr",
      finalizationNonce:
        overrides.finalizationNonce ?? createWorkspaceFinalizationNonce(input),
    },
    requiredAt: overrides.requiredAt ?? "2026-08-13T18:00:01.000Z",
  });
}

describe("executor handoff manifest", () => {
  it("publishes immutable custody and an atomic active-workspace pointer", async () => {
    const prepared = await fixture();
    const store = new ExecutorHandoffManifestStore(prepared.handoffRoot);
    const first = await store.publish({
      requirement: requirement(prepared.worktree),
      activatedAt: "2026-08-13T18:00:02.000Z",
    });
    const second = await store.publish({
      requirement: requirement(prepared.worktree, {
        requiredAt: "2026-08-13T18:00:03.000Z",
      }),
      activatedAt: "2026-08-13T18:00:04.000Z",
    });

    expect(second.manifestPath).toBe(first.manifestPath);
    expect(second.pointer.manifestDigest).toBe(first.pointer.manifestDigest);
    expect(second.pointer.activatedAt).toBe("2026-08-13T18:00:04.000Z");
    expect(
      JSON.parse(await readFile(first.manifestPath, "utf8")),
    ).not.toHaveProperty("binding.requiredAt");
    expect((await lstat(first.manifestPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(first.pointerPath)).mode & 0o777).toBe(0o600);
    await expect(store.loadForWorkspace(prepared.worktree)).resolves.toEqual(
      second,
    );
  });

  it("rejects a changed finalization nonce and changed qualification custody", async () => {
    const prepared = await fixture();
    const store = new ExecutorHandoffManifestStore(prepared.handoffRoot);
    await expect(
      store.publish({
        requirement: requirement(prepared.worktree, {
          finalizationNonce: "00000000-0000-8000-8000-000000000000",
        }),
        activatedAt: "2026-08-13T18:00:02.000Z",
      }),
    ).rejects.toThrow("finalization nonce does not match custody");

    const invalid = requirement(prepared.worktree);
    invalid.handoff.qualification.issue.number = 4_321;
    expect(() => initialWorkspaceRequirementSchema.parse(invalid)).toThrow(
      "changes the qualified issue",
    );
  });

  it("rejects tampered immutable content and a pointer for another workspace", async () => {
    const prepared = await fixture();
    const store = new ExecutorHandoffManifestStore(prepared.handoffRoot);
    const published = await store.publish({
      requirement: requirement(prepared.worktree),
      activatedAt: "2026-08-13T18:00:02.000Z",
    });
    const tampered = JSON.parse(
      await readFile(published.manifestPath, "utf8"),
    ) as { binding: { handoff: { accountId: string } } };
    tampered.binding.handoff.accountId = "another-account";
    await writeFile(published.manifestPath, `${JSON.stringify(tampered)}\n`, {
      mode: 0o600,
    });
    await chmod(published.manifestPath, 0o600);
    await expect(store.loadForWorkspace(prepared.worktree)).rejects.toThrow(
      "digest does not match",
    );
    await expect(
      store.publish({
        requirement: requirement(prepared.worktree),
        activatedAt: "2026-08-13T18:00:03.000Z",
      }),
    ).rejects.toThrow("conflicts with immutable custody");

    await writeFile(
      published.pointerPath,
      `${JSON.stringify({ ...published.pointer, worktree: path.join(prepared.root, "other") })}\n`,
      { mode: 0o600 },
    );
    await expect(store.loadForWorkspace(prepared.worktree)).rejects.toThrow(
      "names another workspace",
    );
  });

  it("rejects symbolic workspace and handoff paths", async () => {
    const prepared = await fixture();
    const workspaceAlias = path.join(prepared.root, "workspace-alias");
    await symlink(prepared.worktree, workspaceAlias);
    await expect(
      new ExecutorHandoffManifestStore(prepared.handoffRoot).publish({
        requirement: requirement(workspaceAlias),
        activatedAt: "2026-08-13T18:00:02.000Z",
      }),
    ).rejects.toThrow("physical directory");

    const physicalHandoffRoot = path.join(prepared.root, "physical-handoffs");
    await mkdir(physicalHandoffRoot);
    const handoffAlias = path.join(prepared.root, "handoff-alias");
    await symlink(physicalHandoffRoot, handoffAlias);
    await expect(
      new ExecutorHandoffManifestStore(handoffAlias).publish({
        requirement: requirement(prepared.worktree),
        activatedAt: "2026-08-13T18:00:02.000Z",
      }),
    ).rejects.toThrow("physical directory");
  });
});
