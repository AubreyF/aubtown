import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { GitCommittedWorkProductStateInspector } from "../adjudication/validation-runner.js";
import { loadPublisherRuntime } from "../config/publisher-runtime.js";
import { FilePrivateKeyProvider } from "../credentials/file-private-key-provider.js";
import { GitHubAppBroker } from "../credentials/github-app-broker.js";
import { initializePublication } from "../orchestration/publication-registry.js";
import {
  GitHttpsBranchPublisher,
  GitHubDraftPublisher,
} from "../publication/draft-publisher.js";
import type { PublicationPlan } from "../publication/policy.js";

const runtimeFile = process.argv[2];
const payload = process.argv[3];
if (runtimeFile === undefined || payload === undefined) {
  throw new Error("Provide the protected publisher runtime and publication payload.");
}
if (
  payload.length < 1 ||
  payload.length > 2 * 1_024 * 1_024 ||
  !/^[A-Za-z0-9_-]+$/u.test(payload)
) {
  throw new Error("Draft publication payload is invalid.");
}
const plan = initializePublication(
  null,
  JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PublicationPlan,
).plan;
const runtime = await loadPublisherRuntime(runtimeFile);
const repository = plan.repository;
if (
  repository === undefined ||
  plan.workProduct?.hostId !== runtime.hostId ||
  !runtime.selectedRepositories.includes(repository)
) {
  throw new Error("Publisher runtime does not own the admitted work product.");
}
const identity = {
  appId: runtime.appId,
  installationId: runtime.installationId,
  privateKeyReference: runtime.privateKeyFile,
  selectedRepositories: runtime.selectedRepositories,
};
const runner = new ProcessCommandRunner();
const receipt = await new GitHubDraftPublisher(
  new GitHubAppBroker(
    identity,
    identity,
    new FilePrivateKeyProvider(),
  ),
  new GitCommittedWorkProductStateInspector(runner, runtime.gitExecutable),
  new GitHttpsBranchPublisher(runner, runtime.gitExecutable),
).publish(plan);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
