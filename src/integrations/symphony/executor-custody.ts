import type { CommandRunner } from "../../adapters/command-runner.js";
import type { WorkerRuntimeConfig } from "../../config/worker-runtime.js";
import { TrustedCompletionReceiptStore } from "../../execution/completion-receipt.js";
import {
  ExecutorHandoffManifestStore,
  type PublishedExecutorHandoff,
} from "../../execution/handoff-manifest.js";
import { assertPreparedSymphonyWorkspace } from "./workspace-guard.js";

export interface AdmittedExecutorCustody extends PublishedExecutorHandoff {
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
}

export async function loadAdmittedExecutorCustody(input: {
  readonly workspace: string;
  readonly runtime: WorkerRuntimeConfig;
  readonly runner: CommandRunner;
  readonly stage: "before-run" | "completion";
}): Promise<AdmittedExecutorCustody> {
  const workspace = await assertPreparedSymphonyWorkspace({
    workspace: input.workspace,
    config: input.runtime,
    runner: input.runner,
    requireClean: input.stage === "before-run",
  });
  const handoff = await new ExecutorHandoffManifestStore(
    input.runtime.handoffRoot,
  ).loadForWorkspace(input.workspace);
  const binding = handoff.manifest.binding;
  if (
    binding.hostId !== input.runtime.hostId ||
    binding.repository.owner !== input.runtime.repository.owner ||
    binding.repository.name !== input.runtime.repository.name ||
    binding.repository.defaultBranch !== input.runtime.repository.defaultBranch ||
    binding.worktree !== input.workspace ||
    binding.branch !== workspace.branch
  ) {
    throw new Error("Executor handoff exceeds the configured runtime custody.");
  }
  if (input.stage === "before-run") {
    const completion = await new TrustedCompletionReceiptStore(
      input.runtime.handoffRoot,
    ).load(handoff.pointer.manifestDigest);
    if (completion !== null) {
      throw new Error(
        "Executor workspace is already finalized and awaits coordinator reconciliation.",
      );
    }
    if (workspace.head !== binding.baseHead) {
      throw new Error("Executor workspace no longer matches its admitted base head.");
    }
  }
  return { ...handoff, ...workspace };
}
