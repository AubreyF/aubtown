import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { WorkerRuntimeConfig } from "../config/worker-runtime.js";
import { loadReviewerRuntimeConfig } from "../config/reviewer-runtime.js";
import { sshTransportProofSchema } from "../security/ssh-worker-policy.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const commit = z.string().regex(/^[0-9a-f]{40}$/u);

export const executorReadinessReportSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  checkedAt: z.iso.datetime(),
  ready: z.literal(true),
  repositoryRoot: z.string().startsWith("/"),
  worktreeRoot: z.string().startsWith("/"),
  handoffRoot: z.string().startsWith("/"),
  baseHead: commit,
  git: z.object({
    executable: z.string().startsWith("/"),
    version: z.string().min(1),
  }),
  node: z.object({
    executable: z.string().startsWith("/"),
    version: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
  }),
  helper: z.object({ path: z.string().startsWith("/"), sha256: digest }),
  preparer: z.object({ path: z.string().startsWith("/"), sha256: digest }),
  completer: z.object({ path: z.string().startsWith("/"), sha256: digest }),
  completionReader: z.object({
    path: z.string().startsWith("/"),
    sha256: digest,
  }),
  adjudicator: z.object({ path: z.string().startsWith("/"), sha256: digest }),
  reviewer: z.object({
    config: z.object({ path: z.string().startsWith("/"), sha256: digest }),
    accountId: z.string().min(1),
    codexExecutable: z.string().startsWith("/"),
    codexHome: z.string().startsWith("/"),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high", "xhigh"]),
    quotaSampleIntervalMs: z.number().int().min(5_000).max(120_000),
  }),
  browserRuntime: z
    .object({
      browser: z.literal("chromium"),
      packageRoot: z.string().startsWith("/"),
      cacheRoot: z.string().startsWith("/"),
      executable: z.string().startsWith("/"),
      sha256: digest,
      version: z.string().min(1),
    })
    .optional(),
});

export type ExecutorReadinessReport = z.infer<
  typeof executorReadinessReportSchema
>;

export const selectedExecutorReadinessReportSchema =
  executorReadinessReportSchema.extend({
    transport: sshTransportProofSchema,
  });

export type SelectedExecutorReadinessReport = z.infer<
  typeof selectedExecutorReadinessReportSchema
>;

async function physicalDirectory(file: string, label: string): Promise<string> {
  const stats = await lstat(file);
  const physical = await realpath(file);
  if (!stats.isDirectory() || stats.isSymbolicLink() || physical !== file) {
    throw new Error(`${label} must be one physical directory.`);
  }
  return physical;
}

async function protectedDirectory(file: string, label: string): Promise<string> {
  const physical = await physicalDirectory(file, label);
  const stats = await lstat(physical);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible to another OS user.`);
  }
  return physical;
}

async function nonWritableDirectory(file: string, label: string): Promise<string> {
  const physical = await physicalDirectory(file, label);
  const stats = await lstat(physical);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${label} cannot be group or other writable.`);
  }
  return physical;
}

async function physicalFile(input: {
  readonly file: string;
  readonly label: string;
  readonly executable: boolean;
  readonly maxBytes?: number;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const stats = await lstat(input.file);
  const physical = await realpath(input.file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    physical !== input.file ||
    stats.size < 1 ||
    stats.size > (input.maxBytes ?? 64 * 1_024 * 1_024) ||
    (stats.mode & 0o022) !== 0 ||
    (input.executable && (stats.mode & 0o111) === 0)
  ) {
    throw new Error(`${input.label} must be one protected physical file.`);
  }
  return {
    path: physical,
    sha256: createHash("sha256").update(await readFile(physical)).digest("hex"),
  };
}

export async function probeExecutorReadiness(input: {
  readonly runtime: WorkerRuntimeConfig;
  readonly preparerFile: string;
  readonly completionFile: string;
  readonly completionReaderFile: string;
  readonly adjudicatorFile: string;
  readonly reviewerRuntimeFile: string;
  readonly runner: CommandRunner;
  readonly checkedAt: string;
  readonly runningNodeExecutable?: string;
  readonly runningNodeVersion?: string;
}): Promise<ExecutorReadinessReport> {
  const repositoryRoot = await physicalDirectory(
    input.runtime.repositoryRoot,
    "Freed repository root",
  );
  const worktreeRoot = await physicalDirectory(
    input.runtime.worktreeRoot,
    "AubTown worktree root",
  );
  await access(worktreeRoot, constants.R_OK | constants.W_OK | constants.X_OK);
  const handoffRoot = await protectedDirectory(
    input.runtime.handoffRoot,
    "AubTown executor handoff root",
  );
  await access(handoffRoot, constants.R_OK | constants.W_OK | constants.X_OK);
  const helper = await physicalFile({
    file: input.runtime.worktreeHelper,
    label: "Freed worktree helper",
    executable: true,
  });
  if (!helper.path.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Freed worktree helper escapes the repository root.");
  }
  const preparer = await physicalFile({
    file: input.preparerFile,
    label: "AubTown workspace preparer",
    executable: false,
  });
  const completer = await physicalFile({
    file: input.completionFile,
    label: "AubTown trusted completion entrypoint",
    executable: false,
  });
  const completionReader = await physicalFile({
    file: input.completionReaderFile,
    label: "AubTown trusted completion reader",
    executable: false,
  });
  const adjudicator = await physicalFile({
    file: input.adjudicatorFile,
    label: "AubTown trusted adjudicator",
    executable: false,
  });
  const reviewerRuntime = await loadReviewerRuntimeConfig(
    input.reviewerRuntimeFile,
  );
  if (reviewerRuntime.hostId !== input.runtime.hostId) {
    throw new Error("Reviewer runtime targets another executor host.");
  }
  const reviewerConfig = await physicalFile({
    file: input.reviewerRuntimeFile,
    label: "AubTown reviewer runtime config",
    executable: false,
  });
  const node = await physicalFile({
    file: input.runtime.nodeExecutable,
    label: "Pinned Node executable",
    executable: true,
    maxBytes: 256 * 1_024 * 1_024,
  });
  const runningNode = await realpath(
    input.runningNodeExecutable ?? process.execPath,
  );
  const runningVersion = input.runningNodeVersion ?? process.version;
  if (runningNode !== node.path || runningVersion !== input.runtime.nodeVersion) {
    throw new Error("Executor probe is not running under the configured Node runtime.");
  }
  let browserRuntime:
    | {
        readonly browser: "chromium";
        readonly packageRoot: string;
        readonly cacheRoot: string;
        readonly executable: string;
        readonly sha256: string;
        readonly version: string;
      }
    | undefined;
  if (input.runtime.browserRuntime !== undefined) {
    const packageRoot = await physicalDirectory(
      input.runtime.browserRuntime.packageRoot,
      "Browser package root",
    );
    if (!packageRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error("Browser package root escapes the repository root.");
    }
    const cacheRoot = await nonWritableDirectory(
      input.runtime.browserRuntime.cacheRoot,
      "Browser cache root",
    );
    const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
    const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cacheRoot;
    let executablePath: string | undefined;
    try {
      const playwright = requireFromPackage("playwright") as {
        readonly chromium?: { executablePath(): string };
      };
      executablePath = playwright.chromium?.executablePath();
    } finally {
      if (previousBrowserPath === undefined) {
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      } else {
        process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
      }
    }
    if (executablePath === undefined || !path.isAbsolute(executablePath)) {
      throw new Error("Playwright Chromium did not resolve one executable.");
    }
    let executable: { readonly path: string; readonly sha256: string };
    try {
      executable = await physicalFile({
        file: executablePath,
        label: "Playwright Chromium executable",
        executable: true,
        maxBytes: 512 * 1_024 * 1_024,
      });
    } catch (error) {
      throw new Error(
        "Playwright Chromium executable is missing or unprotected.",
        { cause: error },
      );
    }
    if (!executable.path.startsWith(`${cacheRoot}${path.sep}`)) {
      throw new Error("Playwright Chromium executable escapes the enrolled cache root.");
    }
    const version = (
      await input.runner.run({
        executable: executable.path,
        args: ["--version"],
        cwd: packageRoot,
        env: { HOME: reviewerRuntime.homeDirectory },
      })
    ).stdout.trim();
    if (version.length === 0) {
      throw new Error("Playwright Chromium returned no version.");
    }
    browserRuntime = {
      browser: input.runtime.browserRuntime.browser,
      packageRoot,
      cacheRoot,
      executable: executable.path,
      sha256: executable.sha256,
      version,
    };
  }
  const git = await physicalFile({
    file: input.runtime.gitExecutable,
    label: "Git executable",
    executable: true,
  });
  const gitVersion = (
    await input.runner.run({
      executable: git.path,
      args: ["--version"],
      cwd: repositoryRoot,
      env: {},
    })
  ).stdout.trim();
  const topLevel = (
    await input.runner.run({
      executable: git.path,
      args: ["rev-parse", "--show-toplevel"],
      cwd: repositoryRoot,
      env: {},
    })
  ).stdout.trim();
  if ((await realpath(topLevel)) !== repositoryRoot) {
    throw new Error("Configured Freed checkout resolves to another repository root.");
  }
  const baseHead = (
    await input.runner.run({
      executable: git.path,
      args: [
        "show-ref",
        "--verify",
        "--hash",
        `refs/remotes/origin/${input.runtime.repository.defaultBranch}`,
      ],
      cwd: repositoryRoot,
      env: {},
    })
  ).stdout.trim();
  return executorReadinessReportSchema.parse({
    schemaVersion: 1,
    hostId: input.runtime.hostId,
    repository: input.runtime.repository,
    checkedAt: input.checkedAt,
    ready: true,
    repositoryRoot,
    worktreeRoot,
    handoffRoot,
    baseHead,
    git: { executable: git.path, version: gitVersion },
    node: { executable: node.path, version: runningVersion },
    helper,
    preparer,
    completer,
    completionReader,
    adjudicator,
    reviewer: {
      config: reviewerConfig,
      accountId: reviewerRuntime.accountId,
      codexExecutable: reviewerRuntime.codexExecutable,
      codexHome: reviewerRuntime.codexHome,
      model: reviewerRuntime.model,
      effort: reviewerRuntime.effort,
      quotaSampleIntervalMs: reviewerRuntime.quotaSampleIntervalMs,
    },
    ...(browserRuntime === undefined ? {} : { browserRuntime }),
  });
}
