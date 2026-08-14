import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { assertAdjudicationCommand } from "../adjudication/command.js";
import { CodexIndependentReviewer } from "../adjudication/codex-reviewer.js";
import { HostAdjudicationJournal } from "../adjudication/journal.js";
import {
  TrustedAdjudicationResultStore,
  TrustedAdjudicationRunner,
} from "../adjudication/trusted-runner.js";
import {
  ExactValidationRunner,
  GitCommittedWorkProductStateInspector,
} from "../adjudication/validation-runner.js";
import { loadReviewerRuntimeConfig } from "../config/reviewer-runtime.js";
import { loadWorkerRuntimeConfig } from "../config/worker-runtime.js";
import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "../drivers/codex/app-server-client.js";
import { CodexQuotaSource } from "../drivers/codex/quota-source.js";

const workerRuntimeFile = process.argv[2];
const reviewerRuntimeFile = process.argv[3];
const payload = process.argv[4];
if (
  workerRuntimeFile === undefined ||
  reviewerRuntimeFile === undefined ||
  payload === undefined ||
  payload.length > 2 * 1_024 * 1_024
) {
  throw new Error(
    "Trusted adjudication requires worker config, reviewer config, and one bounded command payload.",
  );
}
const worker = await loadWorkerRuntimeConfig(workerRuntimeFile);
const reviewerRuntime = await loadReviewerRuntimeConfig(reviewerRuntimeFile);
if (
  reviewerRuntime.hostId !== worker.hostId ||
  reviewerRuntime.accountId.trim() === ""
) {
  throw new Error("Reviewer runtime does not match the worker host.");
}
const command = assertAdjudicationCommand(
  JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  worker.hostId,
);
if (command.accountId !== reviewerRuntime.accountId) {
  throw new Error("Adjudication command targets another reviewer account.");
}
const runner = new ProcessCommandRunner();
const transport = new StdioJsonRpcTransport({
  command: reviewerRuntime.codexExecutable,
  args: ["app-server"],
  env: {
    CODEX_HOME: reviewerRuntime.codexHome,
    HOME: reviewerRuntime.homeDirectory,
    PATH: `${path.dirname(worker.nodeExecutable)}:/usr/bin:/bin`,
  },
});
const client = new CodexAppServerClient(transport);
try {
  await client.assertModelCallable({
    model: reviewerRuntime.model,
    effort: reviewerRuntime.effort,
  });
  const root = path.join(worker.handoffRoot, "adjudications");
  const result = await new TrustedAdjudicationRunner(
    new ExactValidationRunner(
      new GitCommittedWorkProductStateInspector(runner, worker.gitExecutable),
    ),
    new CodexIndependentReviewer(client, {
      model: reviewerRuntime.model,
      effort: reviewerRuntime.effort,
    }),
    new CodexQuotaSource(client),
    {
      interrupt: async (handle) =>
        await client.interrupt(handle.threadId, handle.turnId),
    },
    new HostAdjudicationJournal(
      path.join(root, `journal-${command.commandId}.json`),
    ),
    new TrustedAdjudicationResultStore(root),
    {
      PATH: `${path.dirname(worker.nodeExecutable)}:/usr/bin:/bin`,
      HOME: reviewerRuntime.homeDirectory,
      CI: "1",
    },
    () => new Date(),
    reviewerRuntime.quotaSampleIntervalMs,
  ).run(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await client.close();
}
