import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { GitCustodyCheckpointService } from "../checkpoints/git-custody.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  exactValidationReceiptSchema,
  type ExactValidationReceipt,
  type WorkProductIdentity,
} from "./receipts.js";

const MAX_VALIDATION_OUTPUT_BYTES = 4 * 1_024 * 1_024;

export interface ValidationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export const validationCommandSchema: z.ZodType<ValidationCommand> = z.object({
  executable: z.string().startsWith("/"),
  args: z.array(z.string().max(32 * 1_024)).max(256),
  timeoutMs: z.number().int().min(1).max(60 * 60 * 1_000),
});

export interface ValidationProcessResult {
  readonly executable: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ValidationProcessRunner {
  run(input: {
    readonly command: ValidationCommand;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<ValidationProcessResult>;
}

export interface WorkProductStateInspector {
  inspect(workProduct: WorkProductIdentity): Promise<{
    readonly head: string;
    readonly patchDigest: string;
  }>;
}

export class GitWorkProductStateInspector implements WorkProductStateInspector {
  constructor(private readonly custody: GitCustodyCheckpointService) {}

  async inspect(workProduct: WorkProductIdentity): Promise<{
    readonly head: string;
    readonly patchDigest: string;
  }> {
    const state = await this.custody.inspect({
      repositoryRoot: workProduct.worktree,
      branch: workProduct.branch,
      baseRef: workProduct.baseHead,
    });
    return {
      head: state.repositoryHead,
      patchDigest: state.patchDigest,
    };
  }
}

export class GitCommittedWorkProductStateInspector
  implements WorkProductStateInspector
{
  constructor(
    private readonly runner: CommandRunner,
    private readonly gitExecutable: string,
  ) {}

  async inspect(workProduct: WorkProductIdentity): Promise<{
    readonly head: string;
    readonly patchDigest: string;
  }> {
    const branch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: workProduct.worktree,
      })
    ).stdout.trim();
    const head = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["rev-parse", "HEAD"],
        cwd: workProduct.worktree,
      })
    ).stdout.trim();
    const status = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: workProduct.worktree,
      })
    ).stdout.trim();
    if (
      branch !== workProduct.branch ||
      !/^[0-9a-f]{40}$/u.test(head) ||
      status !== ""
    ) {
      throw new Error("Committed work product is not one clean exact branch head.");
    }
    const patch = (
      await this.runner.run({
        executable: this.gitExecutable,
        args: [
          "diff",
          "--binary",
          "--full-index",
          workProduct.baseHead,
          head,
          "--",
          ".",
        ],
        cwd: workProduct.worktree,
        maxBufferBytes: 256 * 1_024 * 1_024,
      })
    ).stdout;
    return {
      head,
      patchDigest: createHash("sha256").update(patch, "utf8").digest("hex"),
    };
  }
}

export class SpawnValidationProcessRunner implements ValidationProcessRunner {
  async run(input: {
    readonly command: ValidationCommand;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<ValidationProcessResult> {
    if (!isAbsolute(input.command.executable)) {
      throw new Error("Validation executable must be an absolute path.");
    }
    if (
      !Number.isInteger(input.command.timeoutMs) ||
      input.command.timeoutMs < 1 ||
      input.command.timeoutMs > 60 * 60 * 1_000
    ) {
      throw new Error("Validation timeout must be between 1 ms and 1 hour.");
    }
    const executable = await realpath(input.command.executable);
    const stats = await lstat(executable);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
      throw new Error("Validation executable must resolve to a physical executable file.");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error("Validation executable cannot be group or other writable.");
    }
    const started = performance.now();
    return await new Promise<ValidationProcessResult>((resolve, reject) => {
      const child = spawn(executable, [...input.command.args], {
        cwd: input.cwd,
        env: input.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let terminationError: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const terminate = (error: Error): void => {
        if (terminationError !== undefined) {
          return;
        }
        terminationError = error;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
        forceTimer = setTimeout(() => {
          if (process.platform !== "win32" && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else {
            child.kill("SIGKILL");
          }
        }, 2_000);
        forceTimer.unref();
      };
      const timer = setTimeout(() => {
        terminate(new Error("Validation command timed out."));
      }, input.command.timeoutMs);
      timer.unref();
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_VALIDATION_OUTPUT_BYTES) {
          terminate(new Error("Validation output exceeded the 4 MiB limit."));
          return;
        }
        if (target === "stdout") {
          stdout += chunk.toString("utf8");
        } else {
          stderr += chunk.toString("utf8");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (forceTimer !== undefined) {
          clearTimeout(forceTimer);
        }
        if (terminationError !== undefined) {
          reject(terminationError);
          return;
        }
        resolve({
          executable,
          exitCode: code ?? (signal === null ? 1 : 128),
          stdout,
          stderr,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        });
      });
    });
  }
}

export class ExactValidationRunner {
  constructor(
    private readonly inspector: WorkProductStateInspector,
    private readonly processes: ValidationProcessRunner =
      new SpawnValidationProcessRunner(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: {
    readonly workProduct: WorkProductIdentity;
    readonly commands: readonly ValidationCommand[];
    readonly env: NodeJS.ProcessEnv;
  }): Promise<ExactValidationReceipt> {
    if (input.commands.length === 0) {
      throw new Error("Exact validation requires at least one command.");
    }
    await this.#assertExact(input.workProduct);
    const commands = [];
    for (const command of input.commands) {
      let result: ValidationProcessResult;
      try {
        result = await this.processes.run({
          command,
          cwd: input.workProduct.worktree,
          env: input.env,
        });
      } catch (error) {
        await this.#assertExact(input.workProduct);
        throw error;
      }
      await this.#assertExact(input.workProduct);
      commands.push({
        argv: [result.executable, ...command.args],
        cwd: input.workProduct.worktree,
        exitCode: result.exitCode,
        outputDigest: createHash("sha256")
          .update(
            canonicalJson({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            }),
          )
          .digest("hex"),
        durationMs: result.durationMs,
      });
      if (result.exitCode !== 0) {
        break;
      }
    }
    const passed =
      commands.length === input.commands.length &&
      commands.every((command) => command.exitCode === 0);
    return exactValidationReceiptSchema.parse({
      schemaVersion: 1,
      kind: "exact-validation",
      workProduct: input.workProduct,
      passed,
      commands,
      completedAt: this.now().toISOString(),
      summary: passed
        ? `${commands.length.toLocaleString("en-US")} exact validation command${commands.length === 1 ? "" : "s"} passed.`
        : "Exact validation failed.",
    });
  }

  async #assertExact(workProduct: WorkProductIdentity): Promise<void> {
    const current = await this.inspector.inspect(workProduct);
    if (
      current.head !== workProduct.head ||
      current.patchDigest !== workProduct.patchDigest
    ) {
      throw new Error("Worktree no longer matches the authenticated work product.");
    }
  }
}
