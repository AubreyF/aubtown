import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import { ExecutorHandoffManifestStore } from "../execution/handoff-manifest.js";
import { FreedWorkspaceManager } from "../execution/workspace-manager.js";
import {
  initialWorkspaceReceiptSchema,
  initialWorkspaceRequirementSchema,
} from "../execution/workspace.js";

if (process.argv.length !== 4) {
  throw new Error(
    "Workspace preparation requires one runtime config and one encoded requirement.",
  );
}
const runtimeFile = process.argv[2];
const encoded = process.argv[3];
if (
  runtimeFile === undefined ||
  encoded === undefined ||
  encoded.length > 256 * 1024
) {
  throw new Error("Workspace preparation arguments are invalid.");
}
const runtime = await loadWorkerRuntimeConfig(runtimeFile);
const requirement = initialWorkspaceRequirementSchema.parse(
  JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
);
if (
  requirement.hostId !== runtime.hostId ||
  requirement.repository.owner !== runtime.repository.owner ||
  requirement.repository.name !== runtime.repository.name ||
  requirement.repository.defaultBranch !== runtime.repository.defaultBranch
) {
  throw new Error(
    "Workspace requirement exceeds this executor's configured scope.",
  );
}
await new FreedWorkspaceManager(
  runtime.repositoryRoot,
  runtime.worktreeRoot,
  runtime.worktreeHelper,
  new ProcessCommandRunner(),
  runtime.gitExecutable,
  runtime.nodeExecutable,
).prepare({
  worktree: requirement.worktree,
  branch: requirement.branch,
  baseHead: requirement.baseHead,
  target: requirement.target,
});
const preparedAt = new Date().toISOString();
await new ExecutorHandoffManifestStore(runtime.handoffRoot).publish({
  requirement,
  activatedAt: preparedAt,
});
const receipt = initialWorkspaceReceiptSchema.parse({
  schemaVersion: 1,
  claimId: requirement.claimId,
  custodyEpoch: requirement.custodyEpoch,
  hostId: requirement.hostId,
  worktree: requirement.worktree,
  branch: requirement.branch,
  baseHead: requirement.baseHead,
  preparedAt,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
