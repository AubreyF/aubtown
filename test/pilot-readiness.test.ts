import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { CodexIndependentReviewer } from "../src/adjudication/codex-reviewer.js";
import {
  createWorkProductIdentity,
  type WorkProductIdentity,
} from "../src/adjudication/receipts.js";
import {
  ExactValidationRunner,
  GitWorkProductStateInspector,
} from "../src/adjudication/validation-runner.js";
import { XChaChaCheckpointCipher } from "../src/checkpoints/cipher.js";
import { GitCustodyCheckpointService } from "../src/checkpoints/git-custody.js";
import { LocalCheckpointStore } from "../src/checkpoints/local-store.js";
import {
  CodexAppServerClient,
  type JsonRpcTransport,
} from "../src/drivers/codex/app-server-client.js";
import type { WorkerDriver, WorkerTurnHandle } from "../src/drivers/worker.js";
import { GitExecutionCandidateFinalizer } from "../src/execution/candidate-finalizer.js";
import { createExecutorStartCommand } from "../src/execution/command.js";
import type { ExecutionCheckpointManager } from "../src/execution/checkpoint-manager.js";
import { HostExecutionJournal } from "../src/execution/journal.js";
import { HostExecutionSupervisor } from "../src/execution/supervisor.js";
import {
  applyReview,
  applyValidation,
  initializeHandoff,
} from "../src/orchestration/handoff-registry.js";
import {
  initializePublication,
  recordPublication,
} from "../src/orchestration/publication-registry.js";
import { decideQuota } from "../src/policy/quota.js";
import {
  GitHubDraftPublisher,
  type DraftPullRequestClient,
  type DraftPullRequestSnapshot,
} from "../src/publication/draft-publisher.js";
import { planDraftPublication } from "../src/publication/policy.js";
import {
  authorityTask,
  claim,
  report,
  usage,
} from "./helpers.js";

const roots: string[] = [];
const runner = new ProcessCommandRunner();
const gitExecutable =
  process.env.FREEDWORKS_TEST_GIT_EXECUTABLE ?? "/usr/bin/git";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await runner.run({ executable: gitExecutable, args, cwd })
  ).stdout.trim();
}

class ReviewTransport implements JsonRpcTransport {
  readonly messages: unknown[] = [];
  readonly listeners = new Set<(message: unknown) => void>();

  async send(message: unknown): Promise<unknown> {
    this.messages.push(message);
    const method = (message as { readonly method?: string }).method;
    if (method === "initialize") {
      return { userAgent: "pilot-readiness" };
    }
    if (method === "thread/start") {
      return { thread: { id: "review-thread" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "review-turn", status: "inProgress" } };
    }
    throw new Error(`Unexpected review method ${String(method)}.`);
  }

  async notify(message: unknown): Promise<void> {
    this.messages.push(message);
  }

  onNotification(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  async close(): Promise<void> {}
}

describe("assembled Freed pilot readiness", () => {
  it("carries one exact candidate from worker completion to durable draft receipt", async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), "freedworks-pilot-"));
    roots.push(testRoot);
    const worktree = path.join(testRoot, "worktree");
    const store = new LocalCheckpointStore(path.join(testRoot, "checkpoints"));
    await runner.run({
      executable: gitExecutable,
      args: ["init", "-b", "dev", worktree],
      cwd: testRoot,
    });
    await git(worktree, ["config", "user.name", "Freedworks Pilot"]);
    await git(worktree, ["config", "user.email", "pilot@example.invalid"]);
    await mkdir(path.join(worktree, "src"));
    await writeFile(path.join(worktree, "src/value.txt"), "before\n");
    await git(worktree, ["add", "src/value.txt"]);
    await git(worktree, ["commit", "-m", "base"]);
    const baseHead = await git(worktree, ["rev-parse", "HEAD"]);
    await git(worktree, ["switch", "-c", "fix/deterministic-validation"]);

    const qualification = report({
      ownedPaths: ["src/value.txt"],
      logicalLocks: ["pilot-readiness"],
      validation: ["Confirm the changed fixture contains the expected value."],
    });
    const activeClaim = claim({
      worktree,
      conflictDomains: ["logical:pilot-readiness", "path:src/value.txt"],
    });
    const command = createExecutorStartCommand({
      commandId: "50e13459-412e-41f7-809f-0d91dc660d52",
      claim: activeClaim,
      qualification,
      authorityTaskId: "github-issue-1234",
      accountId: "codex-pro-1",
      driverId: "fake-codex",
      baseHead,
      issuedAt: "2026-08-13T08:00:00.000Z",
    });
    const implementation: WorkerTurnHandle = {
      driverId: "codex-app-server-v1",
      threadId: "implementation-thread",
      turnId: "implementation-turn",
      startedAt: "2026-08-13T08:00:01.000Z",
    };
    const worker: WorkerDriver = {
      id: "fake-codex",
      capabilities: {
        hostLanes: ["linux", "macos"],
        canInterrupt: true,
        canReadSubscriptionUsage: true,
        publicationCeiling: "draft-pr",
      },
      start: async () => {
        await writeFile(path.join(worktree, "src/value.txt"), "after\n");
        return implementation;
      },
      recover: async () => "completed",
      wait: async () => "completed",
      interrupt: async () => {},
    };
    const checkpointKey = randomBytes(32);
    const cipher = new XChaChaCheckpointCipher({
      resolve: async () => checkpointKey,
    });
    const custody = new GitCustodyCheckpointService(
      runner,
      cipher,
      store,
      gitExecutable,
    );
    let captured:
      | Awaited<ReturnType<ExecutionCheckpointManager["capture"]>>
      | undefined;
    const checkpoints: ExecutionCheckpointManager = {
      capture: async ({ command: candidate, status, createdAt }) => {
        captured = await custody.capture({
          claim: candidate.claim,
          repositoryRoot: candidate.repositoryRoot,
          baseRef: candidate.baseHead,
          validationReceipts: [
            `executor-command:${candidate.commandId}`,
            `worker-turn:${status}`,
          ],
          keyReference: "pilot:checkpoint-v1",
          createdAt,
        });
        return captured;
      },
      upload: async () => {
        if (captured === undefined) {
          throw new Error("Pilot checkpoint was not captured.");
        }
        return {
          schemaVersion: 1,
          reference: captured.reference,
          contentLength: 1_024,
          hostId: activeClaim.hostId,
          grantNonce: "11111111-1111-4111-8111-111111111111",
          manifest: captured.manifest,
          storedAt: "2026-08-13T08:00:03.000Z",
          signatureBase64: "pilot-edge-signature",
        };
      },
      catalog: async () => {},
    };
    const journal = new HostExecutionJournal(
      path.join(testRoot, "state/execution.json"),
    );
    const reported: string[] = [];
    const supervisor = new HostExecutionSupervisor(
      "codex-pro-1",
      worker,
      journal,
      {
        reportExecutor: async (receipt) => {
          reported.push(receipt.stage);
          return {
            kind: "executor-receipt",
            hostId: activeClaim.hostId,
            sequence: reported.length,
            acceptedAt: "2026-08-13T08:00:04.000Z",
            commandId: receipt.commandId,
            stage: receipt.stage,
            ...(receipt.stage === "started"
              ? {}
              : { checkpointReference: receipt.checkpointReference }),
          };
        },
        reconcileExecutor: async () => {
          throw new Error("Pilot did not require executor reconciliation.");
        },
      },
      { track: () => {}, untrack: () => {} },
      () => {},
      () => new Date("2026-08-13T08:00:04.000Z"),
      checkpoints,
      new GitExecutionCandidateFinalizer(runner, gitExecutable),
    );
    await supervisor.accept(command);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await journal.read();
      if (current?.stage === "completed" && current.reportedAt !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminal = await journal.read();
    expect(terminal).toMatchObject({
      stage: "completed",
      reportedAt: "2026-08-13T08:00:04.000Z",
    });
    expect(reported).toEqual(["started", "completed"]);
    if (
      terminal?.checkpoint === undefined ||
      terminal.handle === undefined ||
      captured === undefined
    ) {
      throw new Error("Pilot terminal evidence is incomplete.");
    }
    expect(
      await git(worktree, ["show", "-s", "--format=%B", "HEAD"]),
    ).toContain("Execution-Receipt:");

    const workProduct = createWorkProductIdentity({
      command,
      checkpointReference: terminal.checkpoint.reference,
      checkpoint: captured.manifest,
      implementation: terminal.handle,
    });
    expect(workProduct.baseHead).toBe(baseHead);
    const validation = await new ExactValidationRunner(
      new GitWorkProductStateInspector(custody),
      undefined,
      () => new Date("2026-08-13T08:00:30.000Z"),
    ).run({
      workProduct,
      commands: [
        {
          executable: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs'); if(fs.readFileSync('src/value.txt','utf8')!=='after\\n') process.exit(1)",
          ],
          timeoutMs: 10_000,
        },
      ],
      env: { PATH: process.env.PATH },
    });
    expect(validation.passed).toBe(true);

    const reviewTransport = new ReviewTransport();
    const reviewer = new CodexIndependentReviewer(
      new CodexAppServerClient(reviewTransport),
      {
        model: "gpt-5.6-sol",
        effort: "high",
        now: () => new Date("2026-08-13T08:00:45.000Z"),
      },
    );
    const reviewHandle = await reviewer.start({
      workProduct,
      qualification,
      repositoryRoot: worktree,
    });
    reviewTransport.emit({
      method: "item/completed",
      params: {
        threadId: reviewHandle.threadId,
        turnId: reviewHandle.turnId,
        item: {
          type: "agentMessage",
          id: "review-message",
          phase: "final_answer",
          text: JSON.stringify({
            verdict: "pass",
            summary: "The exact candidate satisfies its acceptance criteria.",
            findings: [],
          }),
        },
      },
    });
    reviewTransport.emit({
      method: "turn/completed",
      params: {
        turn: { id: reviewHandle.turnId, status: "completed" },
      },
    });
    const review = await reviewer.wait(reviewHandle);
    expect(review.reviewer.threadId).not.toBe(
      workProduct.implementation.threadId,
    );
    const readyHandoff = applyReview(
      applyValidation(initializeHandoff(null, workProduct), validation),
      review,
    );
    expect(readyHandoff).toMatchObject({ stage: "ready", reasons: [] });

    const publicationPlan = planDraftPublication({
      repository: activeClaim.repository,
      qualification,
      claim: activeClaim,
      currentClaim: activeClaim,
      authorityTask: authorityTask(),
      authorityActive: true,
      quota: decideQuota({
        snapshot: usage(),
        now: "2026-08-13T08:01:00.000Z",
      }),
      publicationCeiling: "draft-pr",
      head: workProduct.head,
      workProduct,
      validation,
      review,
      title: "fix: make validation deterministic",
      bodySummary: "Makes validation ordering deterministic.",
      now: "2026-08-13T08:01:00.000Z",
    });
    expect(publicationPlan).toMatchObject({
      allowed: true,
      action: "create-draft",
    });
    let remoteHead: string | null = null;
    let pullRequest: DraftPullRequestSnapshot | undefined;
    const pullRequests: DraftPullRequestClient = {
      readBranchHead: async () => remoteHead,
      findOpenByBranch: async () =>
        pullRequest === undefined ? [] : [pullRequest],
      createDraft: async (input) => {
        pullRequest = {
          number: 42,
          url: "https://github.com/freed-project/freed/pull/42",
          state: "open",
          draft: true,
          branch: input.branch,
          head: remoteHead ?? "",
          base: input.base,
          title: input.title,
          body: input.body,
        };
        return pullRequest;
      },
      updateDraft: async () => {
        throw new Error("Pilot should create, not update, its draft.");
      },
    };
    const publisher = new GitHubDraftPublisher(
      {
        mintDraftPublisher: async ({ repository }) => ({
          token: "pilot-installation-token",
          expiresAt: "2026-08-13T09:00:00.000Z",
          repository,
          permissions: { contents: "write", pull_requests: "write" },
        }),
      },
      new GitWorkProductStateInspector(custody),
      {
        push: async (input) => {
          expect(input.token).toBe("pilot-installation-token");
          expect(input.expectedRemoteHead).toBeUndefined();
          remoteHead = input.head;
        },
      },
      () => pullRequests,
      () => new Date("2026-08-13T08:02:00.000Z"),
    );
    const publicationReceipt = await publisher.publish(publicationPlan);
    const published = recordPublication(
      initializePublication(null, publicationPlan),
      publicationReceipt,
    );
    expect(published).toMatchObject({
      stage: "published",
      receipt: {
        draft: true,
        head: workProduct.head,
        checkpointReference: workProduct.checkpointReference,
      },
    });
    expect(await readFile(path.join(worktree, "src/value.txt"), "utf8")).toBe(
      "after\n",
    );
  });
});
