import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";
import {
  assertTrustedCompletionBundle,
  type TrustedCompletionBundle,
} from "./completion-bundle.js";
import {
  OpenSshWorkerPolicyVerifier,
  type SshWorkerPolicyVerifier,
} from "../security/ssh-worker-policy.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const responseSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("pending"),
    manifestDigest: digestSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("completed"),
    bundle: z.unknown(),
  }),
]);

export interface TrustedCompletionReader {
  read(input: {
    readonly hostId: string;
    readonly manifestDigest: string;
  }): Promise<TrustedCompletionBundle | null>;
}

export interface SshTrustedCompletionReaderConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly remoteNodeExecutable: string;
  readonly remoteReaderExecutable: string;
  readonly remoteRuntimeConfig: string;
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

export class SshTrustedCompletionReader implements TrustedCompletionReader {
  readonly #config: SshTrustedCompletionReaderConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshTrustedCompletionReaderConfig,
    private readonly policy: SshWorkerPolicyVerifier =
      new OpenSshWorkerPolicyVerifier(runner),
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH completion reader paths must be absolute.");
    }
    this.#config = {
      ...config,
      remoteNodeExecutable: commandPath(
        config.remoteNodeExecutable,
        "Remote Node executable",
      ),
      remoteReaderExecutable: commandPath(
        config.remoteReaderExecutable,
        "Remote completion reader",
      ),
      remoteRuntimeConfig: commandPath(
        config.remoteRuntimeConfig,
        "Remote worker runtime config",
      ),
    };
  }

  async read(input: {
    readonly hostId: string;
    readonly manifestDigest: string;
  }): Promise<TrustedCompletionBundle | null> {
    const manifestDigest = digestSchema.parse(input.manifestDigest);
    await this.policy.verify({
      sshExecutable: this.#config.sshExecutable,
      sshConfig: this.#config.sshConfig,
      commandCwd: this.#config.commandCwd,
      hostId: input.hostId,
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
        input.hostId,
        this.#config.remoteNodeExecutable,
        this.#config.remoteReaderExecutable,
        this.#config.remoteRuntimeConfig,
        manifestDigest,
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 20_000,
      maxBufferBytes: 2 * 1_024 * 1_024,
    });
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote completion reader returned an invalid response.");
    }
    const response = responseSchema.parse(JSON.parse(lines[0] ?? ""));
    if (response.status === "pending") {
      if (response.manifestDigest !== manifestDigest) {
        throw new Error("Remote pending response changes the manifest digest.");
      }
      return null;
    }
    const bundle = assertTrustedCompletionBundle(response.bundle);
    if (
      bundle.manifestDigest !== manifestDigest ||
      bundle.receipt.hostId !== input.hostId
    ) {
      throw new Error("Remote completion response changes selected custody.");
    }
    return bundle;
  }
}
