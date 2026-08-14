import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";
import {
  initializePublication,
  recordPublication,
} from "../orchestration/publication-registry.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  OpenSshWorkerPolicyVerifier,
  type SshWorkerPolicyVerifier,
} from "../security/ssh-worker-policy.js";
import {
  draftPublicationReceiptSchema,
  type DraftPublicationReceipt,
} from "./draft-publisher.js";
import type { PublicationPlan } from "./policy.js";

export interface RemoteDraftPublisher {
  publish(plan: PublicationPlan): Promise<DraftPublicationReceipt>;
}

export interface SshDraftPublisherConfig {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly remoteHostAlias: string;
  readonly remoteNodeExecutable: string;
  readonly remotePublisherExecutable: string;
  readonly remotePublisherRuntime: string;
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

export class SshDraftPublisher implements RemoteDraftPublisher {
  readonly #config: SshDraftPublisherConfig;

  constructor(
    private readonly runner: CommandRunner,
    config: SshDraftPublisherConfig,
    private readonly policy: SshWorkerPolicyVerifier =
      new OpenSshWorkerPolicyVerifier(runner),
  ) {
    if (
      !path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfig) ||
      !path.isAbsolute(config.commandCwd)
    ) {
      throw new Error("SSH draft publication paths must be absolute.");
    }
    this.#config = {
      ...config,
      remoteNodeExecutable: commandPath(
        config.remoteNodeExecutable,
        "Remote Node executable",
      ),
      remotePublisherExecutable: commandPath(
        config.remotePublisherExecutable,
        "Remote publisher executable",
      ),
      remotePublisherRuntime: commandPath(
        config.remotePublisherRuntime,
        "Remote publisher runtime",
      ),
    };
  }

  async publish(rawPlan: PublicationPlan): Promise<DraftPublicationReceipt> {
    const state = initializePublication(null, rawPlan);
    const plan = state.plan;
    const hostId = plan.workProduct?.hostId;
    if (hostId === undefined) {
      throw new Error("Draft publication plan lacks a custody host.");
    }
    const publisherAlias = `${hostId}-publisher`;
    if (this.#config.remoteHostAlias !== publisherAlias) {
      throw new Error("Draft publisher alias does not match the custody host.");
    }
    await this.policy.verify({
      sshExecutable: this.#config.sshExecutable,
      sshConfig: this.#config.sshConfig,
      commandCwd: this.#config.commandCwd,
      hostId: publisherAlias,
      expectedUser: this.#config.expectedUser,
      expectedIdentityFile: this.#config.expectedIdentityFile,
      expectedKnownHostsFile: this.#config.expectedKnownHostsFile,
      ...(this.#config.requiredConfigUid === undefined
        ? {}
        : { requiredConfigUid: this.#config.requiredConfigUid }),
    });
    const payload = Buffer.from(canonicalJson(plan)).toString("base64url");
    if (payload.length > 2 * 1_024 * 1_024) {
      throw new Error("Draft publication plan exceeds the SSH boundary.");
    }
    const response = await this.runner.run({
      executable: this.#config.sshExecutable,
      args: [
        "-F",
        this.#config.sshConfig,
        "--",
        publisherAlias,
        this.#config.remoteNodeExecutable,
        this.#config.remotePublisherExecutable,
        this.#config.remotePublisherRuntime,
        payload,
      ],
      cwd: this.#config.commandCwd,
      timeoutMs: 6 * 60 * 1_000,
      maxBufferBytes: 1024 * 1024,
    });
    const lines = response.stdout.trim().split("\n");
    if (lines.length !== 1) {
      throw new Error("Remote draft publisher returned an invalid response.");
    }
    const receipt = draftPublicationReceiptSchema.parse(
      JSON.parse(lines[0] ?? ""),
    );
    recordPublication(state, receipt);
    return receipt;
  }
}
