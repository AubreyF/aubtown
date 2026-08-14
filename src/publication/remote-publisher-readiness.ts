import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import {
  publisherReadinessReportSchema,
  selectedPublisherReadinessReportSchema,
  type SelectedPublisherReadinessReport,
} from "./publisher-readiness.js";
import {
  OpenSshWorkerPolicyVerifier,
  type SshWorkerPolicyVerifier,
} from "../security/ssh-worker-policy.js";

export interface SshPublisherReadinessConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly expectedUser: string;
  readonly expectedIdentityFile: string;
  readonly expectedKnownHostsFile: string;
  readonly requiredConfigUid?: number;
}

export class SshPublisherReadinessProbe {
  readonly #config: SshPublisherReadinessConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshPublisherReadinessConfig,
    private readonly policy: SshWorkerPolicyVerifier =
      new OpenSshWorkerPolicyVerifier(runner),
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH publisher readiness paths must be absolute.");
    }
    this.#config = config;
  }

  async probe(hostId: string): Promise<SelectedPublisherReadinessReport> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hostId)) {
      throw new Error("Publisher host ID is invalid.");
    }
    const alias = `${hostId}-publisher`;
    const transport = await this.policy.verify({
      sshExecutable: this.#config.sshExecutable,
      sshConfig: this.#config.sshConfig,
      commandCwd: this.#config.commandCwd,
      hostId: alias,
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
        alias,
        "probe",
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 20_000,
      maxBufferBytes: 1024 * 1024,
    });
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote publisher probe returned an invalid response.");
    }
    const report = publisherReadinessReportSchema.parse(
      JSON.parse(lines[0] ?? ""),
    );
    if (report.hostId !== hostId) {
      throw new Error("Remote publisher probe returned another host identity.");
    }
    return selectedPublisherReadinessReportSchema.parse({
      ...report,
      transport,
    });
  }
}
