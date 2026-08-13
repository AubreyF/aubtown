import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    const result = await execFileAsync(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env ?? process.env,
      encoding: "utf8",
      maxBuffer: request.maxBufferBytes ?? 4 * 1_024 * 1_024,
      timeout: request.timeoutMs ?? 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}
