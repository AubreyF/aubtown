import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import {
  canonicalJson,
  canonicalJsonEqual,
} from "../security/canonical-json.js";
import {
  OpenSshWorkerPolicyVerifier,
  type SshWorkerPolicyVerifier,
} from "../security/ssh-worker-policy.js";
import type { AdjudicationCommand } from "./command.js";
import { assertAdjudicationCommand } from "./command.js";
import {
  trustedAdjudicationResultSchema,
  type TrustedAdjudicationResult,
} from "./trusted-runner.js";

export interface RemoteAdjudicationRunner {
  run(command: AdjudicationCommand): Promise<TrustedAdjudicationResult>;
}

export interface SshAdjudicationRunnerConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly remoteNodeExecutable: string;
  readonly remoteAdjudicatorExecutable: string;
  readonly remoteWorkerRuntimeConfig: string;
  readonly remoteReviewerRuntimeConfig: string;
  readonly expectedUser: string;
  readonly expectedIdentityFile: string;
  readonly expectedKnownHostsFile: string;
  readonly requiredConfigUid?: number;
}

function commandPath(value: string, label: string): string {
  if (!path.isAbsolute(value) || !/^[A-Za-z0-9_./-]+$/u.test(value)) {
    throw new Error(`${label} must be one shell-safe absolute path.`);
  }
  return value;
}

export class SshAdjudicationRunner implements RemoteAdjudicationRunner {
  readonly #config: SshAdjudicationRunnerConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshAdjudicationRunnerConfig,
    private readonly policy: SshWorkerPolicyVerifier =
      new OpenSshWorkerPolicyVerifier(runner),
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH adjudication paths must be absolute.");
    }
    this.#config = {
      ...config,
      remoteNodeExecutable: commandPath(
        config.remoteNodeExecutable,
        "Remote Node executable",
      ),
      remoteAdjudicatorExecutable: commandPath(
        config.remoteAdjudicatorExecutable,
        "Remote adjudicator",
      ),
      remoteWorkerRuntimeConfig: commandPath(
        config.remoteWorkerRuntimeConfig,
        "Remote worker runtime config",
      ),
      remoteReviewerRuntimeConfig: commandPath(
        config.remoteReviewerRuntimeConfig,
        "Remote reviewer runtime config",
      ),
    };
  }

  async run(rawCommand: AdjudicationCommand): Promise<TrustedAdjudicationResult> {
    const command = assertAdjudicationCommand(rawCommand);
    await this.policy.verify({
      sshExecutable: this.#config.sshExecutable,
      sshConfig: this.#config.sshConfig,
      commandCwd: this.#config.commandCwd,
      hostId: command.workProduct.hostId,
      expectedUser: this.#config.expectedUser,
      expectedIdentityFile: this.#config.expectedIdentityFile,
      expectedKnownHostsFile: this.#config.expectedKnownHostsFile,
      ...(this.#config.requiredConfigUid === undefined
        ? {}
        : { requiredConfigUid: this.#config.requiredConfigUid }),
    });
    const payload = Buffer.from(canonicalJson(command)).toString("base64url");
    const result = await this.runner.run({
      executable: this.#config.sshExecutable,
      args: [
        "-F",
        this.#config.sshConfig,
        "--",
        command.workProduct.hostId,
        this.#config.remoteNodeExecutable,
        this.#config.remoteAdjudicatorExecutable,
        this.#config.remoteWorkerRuntimeConfig,
        this.#config.remoteReviewerRuntimeConfig,
        payload,
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxBufferBytes: 4 * 1_024 * 1_024,
    });
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote adjudicator returned an invalid response.");
    }
    const receipt = trustedAdjudicationResultSchema.parse(
      JSON.parse(lines[0] ?? ""),
    );
    if (
      receipt.commandId !== command.commandId ||
      !canonicalJsonEqual(
        receipt.validation.workProduct,
        command.workProduct,
      ) ||
      (receipt.review !== undefined &&
        !canonicalJsonEqual(receipt.review.workProduct, command.workProduct))
    ) {
      throw new Error("Remote adjudication result changes its work product.");
    }
    return receipt;
  }
}
