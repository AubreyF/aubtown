import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  canonicalJsonEqual,
} from "../security/canonical-json.js";
import {
  loadProtectedJsonFile,
  writeProtectedJsonFile,
} from "../security/protected-json.js";
import {
  createWorkspaceFinalizationNonce,
  initialWorkspaceHandoffBindingSchema,
  initialWorkspaceRequirementSchema,
  type InitialWorkspaceRequirement,
} from "./workspace.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const executorHandoffManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("executor-handoff"),
  binding: initialWorkspaceHandoffBindingSchema,
});

export type ExecutorHandoffManifest = z.infer<
  typeof executorHandoffManifestSchema
>;

export const activeWorkspacePointerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("active-executor-workspace"),
  worktree: z.string().startsWith("/"),
  claimId: z.string().min(1),
  custodyEpoch: z.literal(1),
  hostId: z.string().min(1),
  manifestDigest: digestSchema,
  manifestFile: z.string().regex(/^manifest-[0-9a-f]{64}\.json$/u),
  activatedAt: z.iso.datetime(),
});

export type ActiveWorkspacePointer = z.infer<
  typeof activeWorkspacePointerSchema
>;

export interface PublishedExecutorHandoff {
  readonly manifest: ExecutorHandoffManifest;
  readonly pointer: ActiveWorkspacePointer;
  readonly manifestPath: string;
  readonly pointerPath: string;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyPresent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: string }).code === "EEXIST"
  );
}

function manifestFromRequirement(
  input: InitialWorkspaceRequirement,
): ExecutorHandoffManifest {
  const requirement = initialWorkspaceRequirementSchema.parse(input);
  const { requiredAt: _requiredAt, ...binding } = requirement;
  return executorHandoffManifestSchema.parse({
    schemaVersion: 1,
    kind: "executor-handoff",
    binding,
  });
}

function expectedFinalizationNonce(manifest: ExecutorHandoffManifest): string {
  const binding = manifest.binding;
  return createWorkspaceFinalizationNonce({
    repository: binding.repository,
    issueNumber: binding.issueNumber,
    claimId: binding.claimId,
    custodyEpoch: binding.custodyEpoch,
    hostId: binding.hostId,
    workerId: binding.workerId,
    worktree: binding.worktree,
    branch: binding.branch,
    authorityTaskId: binding.handoff.authorityTaskId,
    authorityTaskRevision: binding.handoff.authorityTaskRevision,
    accountId: binding.handoff.accountId,
    driverId: binding.handoff.driverId,
    baseHead: binding.baseHead,
  });
}

export class ExecutorHandoffManifestStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("Executor handoff root must be absolute.");
    }
  }

  async publish(input: {
    readonly requirement: InitialWorkspaceRequirement;
    readonly activatedAt: string;
  }): Promise<PublishedExecutorHandoff> {
    const activatedAt = z.iso.datetime().parse(input.activatedAt);
    await this.#assertPhysicalWorkspace(input.requirement.worktree);
    const manifest = manifestFromRequirement(input.requirement);
    if (
      manifest.binding.handoff.finalizationNonce !==
      expectedFinalizationNonce(manifest)
    ) {
      throw new Error(
        "Executor handoff finalization nonce does not match custody.",
      );
    }
    const manifestDigest = sha256(canonicalJson(manifest));
    const manifestFile = `manifest-${manifestDigest}.json`;
    const manifestPath = path.join(this.root, manifestFile);
    await this.#writeImmutableManifest(manifestPath, manifest);
    const pointer = activeWorkspacePointerSchema.parse({
      schemaVersion: 1,
      kind: "active-executor-workspace",
      worktree: manifest.binding.worktree,
      claimId: manifest.binding.claimId,
      custodyEpoch: manifest.binding.custodyEpoch,
      hostId: manifest.binding.hostId,
      manifestDigest,
      manifestFile,
      activatedAt,
    });
    const pointerPath = this.#pointerPath(pointer.worktree);
    await writeProtectedJsonFile({
      file: pointerPath,
      label: "Active executor workspace pointer",
      value: pointer,
    });
    return { manifest, pointer, manifestPath, pointerPath };
  }

  async loadForWorkspace(worktree: string): Promise<PublishedExecutorHandoff> {
    await this.#assertPhysicalWorkspace(worktree);
    const pointerPath = this.#pointerPath(worktree);
    const pointer = activeWorkspacePointerSchema.parse(
      await loadProtectedJsonFile({
        file: pointerPath,
        label: "Active executor workspace pointer",
      }),
    );
    if (pointer.worktree !== worktree) {
      throw new Error("Executor handoff pointer names another workspace.");
    }
    if (pointer.manifestFile !== `manifest-${pointer.manifestDigest}.json`) {
      throw new Error("Executor handoff pointer changes its manifest digest.");
    }
    const manifestPath = path.join(this.root, pointer.manifestFile);
    const manifest = executorHandoffManifestSchema.parse(
      await loadProtectedJsonFile({
        file: manifestPath,
        label: "Executor handoff manifest",
      }),
    );
    if (sha256(canonicalJson(manifest)) !== pointer.manifestDigest) {
      throw new Error(
        "Executor handoff manifest digest does not match its pointer.",
      );
    }
    const binding = manifest.binding;
    if (
      binding.worktree !== pointer.worktree ||
      binding.claimId !== pointer.claimId ||
      binding.custodyEpoch !== pointer.custodyEpoch ||
      binding.hostId !== pointer.hostId
    ) {
      throw new Error(
        "Executor handoff manifest does not match active custody.",
      );
    }
    if (
      binding.handoff.finalizationNonce !== expectedFinalizationNonce(manifest)
    ) {
      throw new Error(
        "Executor handoff finalization nonce does not match custody.",
      );
    }
    return { manifest, pointer, manifestPath, pointerPath };
  }

  #pointerPath(worktree: string): string {
    const digest = sha256(
      canonicalJson({
        domain: "aubtown.active-executor-workspace.v1",
        worktree,
      }),
    );
    return path.join(this.root, `workspace-${digest}.json`);
  }

  async #writeImmutableManifest(
    file: string,
    manifest: ExecutorHandoffManifest,
  ): Promise<void> {
    await this.#prepareRoot();
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isAlreadyPresent(error)) {
        throw error;
      }
      const existing = executorHandoffManifestSchema.parse(
        await loadProtectedJsonFile({
          file,
          label: "Executor handoff manifest",
        }),
      );
      if (!canonicalJsonEqual(existing, manifest)) {
        throw new Error(
          "Executor handoff manifest conflicts with immutable custody.",
        );
      }
      return;
    } finally {
      await handle?.close();
    }
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Executor handoff root must be a physical directory.");
    }
    await chmod(this.root, 0o700);
    if ((await realpath(this.root)) !== this.root) {
      throw new Error("Executor handoff root cannot contain symbolic links.");
    }
  }

  async #assertPhysicalWorkspace(worktree: string): Promise<void> {
    if (!path.isAbsolute(worktree)) {
      throw new Error("Executor handoff workspace must be absolute.");
    }
    const stats = await lstat(worktree);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        "Executor handoff workspace must be a physical directory.",
      );
    }
    if ((await realpath(worktree)) !== worktree) {
      throw new Error(
        "Executor handoff workspace cannot contain symbolic links.",
      );
    }
  }
}
