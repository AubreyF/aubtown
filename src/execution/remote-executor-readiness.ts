import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import {
  executorReadinessReportSchema,
  selectedExecutorReadinessReportSchema,
  type SelectedExecutorReadinessReport,
} from "./executor-readiness.js";
import {
  OpenSshWorkerPolicyVerifier,
  type SshWorkerPolicyVerifier,
} from "../security/ssh-worker-policy.js";

export interface SshExecutorReadinessConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly remoteNodeExecutable: string;
  readonly remoteProbeExecutable: string;
  readonly remoteRuntimeConfig: string;
  readonly remoteWorkspacePreparer: string;
  readonly expectedUser: string;
  readonly expectedIdentityFile: string;
  readonly expectedKnownHostsFile: string;
  readonly requiredConfigUid?: number;
}

function remoteToken(value: string, label: string): string {
  if (!path.isAbsolute(value) || !/^[A-Za-z0-9_./-]+$/u.test(value)) {
    throw new Error(`${label} must be one shell-safe absolute path.`);
  }
  return value;
}

export class SshExecutorReadinessProbe {
  readonly #config: SshExecutorReadinessConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshExecutorReadinessConfig,
    private readonly policy: SshWorkerPolicyVerifier =
      new OpenSshWorkerPolicyVerifier(runner),
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH executor readiness paths must be absolute.");
    }
    this.#config = {
      ...config,
      remoteNodeExecutable: remoteToken(
        config.remoteNodeExecutable,
        "Remote Node executable",
      ),
      remoteProbeExecutable: remoteToken(
        config.remoteProbeExecutable,
        "Remote executor probe",
      ),
      remoteRuntimeConfig: remoteToken(
        config.remoteRuntimeConfig,
        "Remote worker runtime config",
      ),
      remoteWorkspacePreparer: remoteToken(
        config.remoteWorkspacePreparer,
        "Remote workspace preparer",
      ),
    };
  }

  async probe(hostId: string): Promise<SelectedExecutorReadinessReport> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hostId)) {
      throw new Error("Executor host ID is invalid.");
    }
    const transport = await this.policy.verify({
      sshExecutable: this.#config.sshExecutable,
      sshConfig: this.#config.sshConfig,
      commandCwd: this.#config.commandCwd,
      hostId,
      expectedUser: this.#config.expectedUser,
      expectedIdentityFile: this.#config.expectedIdentityFile,
      expectedKnownHostsFile: this.#config.expectedKnownHostsFile,
      ...(this.#config.requiredConfigUid === undefined
        ? {}
        : { requiredConfigUid: this.#config.requiredConfigUid }),
    });
    const result = await this.runner.run({
      executable: this.#config.sshExecutable,
      args: [
        "-F",
        this.#config.sshConfig,
        "--",
        hostId,
        this.#config.remoteNodeExecutable,
        this.#config.remoteProbeExecutable,
        this.#config.remoteRuntimeConfig,
        this.#config.remoteWorkspacePreparer,
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 20_000,
      maxBufferBytes: 1024 * 1024,
    });
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote executor probe returned an invalid response.");
    }
    const report = executorReadinessReportSchema.parse(
      JSON.parse(lines[0] ?? ""),
    );
    if (report.hostId !== hostId) {
      throw new Error("Remote executor probe returned another host identity.");
    }
    return selectedExecutorReadinessReportSchema.parse({ ...report, transport });
  }
}
