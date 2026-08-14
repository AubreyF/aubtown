import { realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import { GitCommittedWorkProductStateInspector } from "../adjudication/validation-runner.js";
import { loadPublisherRuntime } from "../config/publisher-runtime.js";
import { FilePrivateKeyProvider } from "../credentials/file-private-key-provider.js";
import { GitHubAppBroker } from "../credentials/github-app-broker.js";
import { initializePublication } from "../orchestration/publication-registry.js";
import {
  GitHttpsBranchPublisher,
  GitHubDraftPublisher,
  type DraftPublicationReceipt,
} from "./draft-publisher.js";
import type { PublicationPlan } from "./policy.js";

function publicationPayload(value: string): PublicationPlan {
  if (
    value.length < 1 ||
    value.length > 2 * 1_024 * 1_024 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Draft publication payload is invalid.");
  }
  return initializePublication(
    null,
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PublicationPlan,
  ).plan;
}

export async function publishDraftLocally(input: {
  readonly runtimeFile: string;
  readonly payload: string;
  readonly runner: CommandRunner;
}): Promise<DraftPublicationReceipt> {
  const plan = publicationPayload(input.payload);
  const runtime = await loadPublisherRuntime(input.runtimeFile);
  const repository = plan.repository;
  if (
    repository === undefined ||
    plan.workProduct?.hostId !== runtime.hostId ||
    !runtime.selectedRepositories.includes(repository)
  ) {
    throw new Error("Publisher runtime does not own the admitted work product.");
  }
  const worktree = await realpath(plan.workProduct.worktree);
  const allowedRoots = await Promise.all(
    runtime.worktreeRoots.map(async (root) => await realpath(root)),
  );
  if (
    !allowedRoots.some((root) => {
      const relative = path.relative(root, worktree);
      return (
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      );
    })
  ) {
    throw new Error("Publisher runtime does not admit this worktree root.");
  }
  const identity = {
    appId: runtime.appId,
    installationId: runtime.installationId,
    privateKeyReference: runtime.privateKeyFile,
    selectedRepositories: runtime.selectedRepositories,
  };
  return await new GitHubDraftPublisher(
    new GitHubAppBroker(identity, identity, new FilePrivateKeyProvider()),
    new GitCommittedWorkProductStateInspector(input.runner, runtime.gitExecutable),
    new GitHttpsBranchPublisher(input.runner, runtime.gitExecutable),
  ).publish(plan);
}
