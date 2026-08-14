import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  initialWorkspaceReceiptSchema,
  initialWorkspaceRequirementSchema,
  type InitialWorkspacePreparer,
  type InitialWorkspaceReceipt,
  type InitialWorkspaceRequirement,
} from "./workspace.js";

export interface SshWorkspacePreparerConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly remoteNodeExecutable: string;
  readonly remotePreparerExecutable: string;
  readonly remoteRuntimeConfig: string;
}

function absoluteCommandToken(value: string, label: string): string {
  if (!path.isAbsolute(value) || !/^[A-Za-z0-9_./-]+$/u.test(value)) {
    throw new Error(`${label} must be one shell-safe absolute path.`);
  }
  return value;
}

function assertExactReceipt(
  requirement: InitialWorkspaceRequirement,
  receipt: InitialWorkspaceReceipt,
): InitialWorkspaceReceipt {
  const exact =
    receipt.claimId === requirement.claimId &&
    receipt.custodyEpoch === requirement.custodyEpoch &&
    receipt.hostId === requirement.hostId &&
    receipt.worktree === requirement.worktree &&
    receipt.branch === requirement.branch &&
    receipt.baseHead === requirement.baseHead;
  if (!exact) {
    throw new Error("Remote workspace receipt does not match the admitted claim.");
  }
  return receipt;
}

export class SshInitialWorkspacePreparer implements InitialWorkspacePreparer {
  readonly #config: SshWorkspacePreparerConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshWorkspacePreparerConfig,
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH workspace preparation paths must be absolute.");
    }
    this.#config = {
      ...config,
      remoteNodeExecutable: absoluteCommandToken(
        config.remoteNodeExecutable,
        "Remote Node executable",
      ),
      remotePreparerExecutable: absoluteCommandToken(
        config.remotePreparerExecutable,
        "Remote workspace preparer",
      ),
      remoteRuntimeConfig: absoluteCommandToken(
        config.remoteRuntimeConfig,
        "Remote worker runtime config",
      ),
    };
  }

  async prepare(
    input: InitialWorkspaceRequirement,
  ): Promise<InitialWorkspaceReceipt> {
    const requirement = initialWorkspaceRequirementSchema.parse(input);
    const payload = Buffer.from(canonicalJson(requirement)).toString("base64url");
    const result = await this.runner.run({
      executable: this.#config.sshExecutable,
      args: [
        "-F",
        this.#config.sshConfig,
        "--",
        requirement.hostId,
        this.#config.remoteNodeExecutable,
        this.#config.remotePreparerExecutable,
        this.#config.remoteRuntimeConfig,
        payload,
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 50_000,
      maxBufferBytes: 1024 * 1024,
    });
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote workspace preparer returned an invalid response.");
    }
    return assertExactReceipt(
      requirement,
      initialWorkspaceReceiptSchema.parse(JSON.parse(lines[0] ?? "")),
    );
  }
}
