import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../adapters/command-runner.js";

const hostIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export const sshTransportProofSchema = z.object({
  hostId: z.string().regex(hostIdPattern),
  hostname: z.string().min(1),
  user: z.string().min(1),
  identityFile: z.string().startsWith("/"),
  knownHostsFile: z.string().startsWith("/"),
  configSha256: z.string().regex(digestPattern),
  sshExecutableSha256: z.string().regex(digestPattern),
});

export type SshTransportProof = z.infer<typeof sshTransportProofSchema>;

export interface SshWorkerPolicyInput {
  readonly sshExecutable: string;
  readonly sshConfig: string;
  readonly commandCwd: string;
  readonly hostId: string;
  readonly expectedUser: string;
  readonly expectedIdentityFile: string;
  readonly expectedKnownHostsFile: string;
  readonly requiredConfigUid?: number;
}

export interface SshWorkerPolicyVerifier {
  verify(input: SshWorkerPolicyInput): Promise<SshTransportProof>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function protectedPhysicalFile(input: {
  readonly file: string;
  readonly label: string;
  readonly executable: boolean;
  readonly maxBytes: number;
  readonly requiredUid?: number;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  if (!path.isAbsolute(input.file) || (await realpath(input.file)) !== input.file) {
    throw new Error(`${input.label} must be one absolute physical file.`);
  }
  const stats = await lstat(input.file);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > input.maxBytes ||
    (stats.mode & 0o022) !== 0 ||
    (input.executable && (stats.mode & 0o111) === 0) ||
    (input.requiredUid !== undefined && stats.uid !== input.requiredUid)
  ) {
    throw new Error(`${input.label} has unsafe type, owner, mode, or size.`);
  }
  return { path: input.file, sha256: sha256(await readFile(input.file)) };
}

function parseSshConfiguration(output: string): ReadonlyMap<string, readonly string[]> {
  const parsed = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf(" ");
    if (separator < 1) {
      throw new Error("Expanded SSH worker configuration is malformed.");
    }
    const key = trimmed.slice(0, separator).toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    const values = parsed.get(key) ?? [];
    values.push(value);
    parsed.set(key, values);
  }
  return parsed;
}

function one(
  config: ReadonlyMap<string, readonly string[]>,
  key: string,
): string {
  const values = config.get(key);
  if (values === undefined || values.length !== 1 || values[0] === "") {
    throw new Error(`SSH worker policy requires one ${key} value.`);
  }
  return values[0] ?? "";
}

function requireValue(
  config: ReadonlyMap<string, readonly string[]>,
  key: string,
  expected: string,
): void {
  if (one(config, key) !== expected) {
    throw new Error(`SSH worker policy requires ${key} ${expected}.`);
  }
}

function requireBoolean(
  config: ReadonlyMap<string, readonly string[]>,
  key: string,
  expected: boolean,
): void {
  const value = one(config, key).toLowerCase();
  const actual =
    value === "yes" || value === "true"
      ? true
      : value === "no" || value === "false"
        ? false
        : undefined;
  if (actual !== expected) {
    throw new Error(
      `SSH worker policy requires ${key} ${expected ? "yes" : "no"}.`,
    );
  }
}

export class OpenSshWorkerPolicyVerifier implements SshWorkerPolicyVerifier {
  constructor(private readonly runner: CommandRunner) {}

  async verify(input: SshWorkerPolicyInput): Promise<SshTransportProof> {
    if (
      !hostIdPattern.test(input.hostId) ||
      input.expectedUser.trim() === "" ||
      !path.isAbsolute(input.expectedIdentityFile) ||
      !path.isAbsolute(input.expectedKnownHostsFile) ||
      !path.isAbsolute(input.commandCwd)
    ) {
      throw new Error("SSH worker policy input is invalid.");
    }
    const ssh = await protectedPhysicalFile({
      file: input.sshExecutable,
      label: "SSH executable",
      executable: true,
      maxBytes: 64 * 1_024 * 1_024,
    });
    const configFile = await protectedPhysicalFile({
      file: input.sshConfig,
      label: "SSH worker config",
      executable: false,
      maxBytes: 64 * 1_024,
      ...(input.requiredConfigUid === undefined
        ? {}
        : { requiredUid: input.requiredConfigUid }),
    });
    const expanded = parseSshConfiguration(
      (
        await this.runner.run({
          executable: ssh.path,
          args: ["-G", "-F", configFile.path, "--", input.hostId],
          cwd: input.commandCwd,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          timeoutMs: 5_000,
          maxBufferBytes: 1024 * 1024,
        })
      ).stdout,
    );
    const hostname = one(expanded, "hostname");
    if (/replace|example\.invalid/iu.test(hostname)) {
      throw new Error("SSH worker hostname is still a placeholder.");
    }
    requireValue(expanded, "user", input.expectedUser);
    requireBoolean(expanded, "batchmode", true);
    requireBoolean(expanded, "stricthostkeychecking", true);
    requireValue(expanded, "hostkeyalias", input.hostId);
    requireBoolean(expanded, "identitiesonly", true);
    requireBoolean(expanded, "passwordauthentication", false);
    requireBoolean(expanded, "kbdinteractiveauthentication", false);
    requireBoolean(expanded, "pubkeyauthentication", true);
    requireValue(expanded, "preferredauthentications", "publickey");
    requireBoolean(expanded, "gssapiauthentication", false);
    requireBoolean(expanded, "hostbasedauthentication", false);
    requireBoolean(expanded, "forwardagent", false);
    requireBoolean(expanded, "clearallforwardings", true);
    requireBoolean(expanded, "requesttty", false);
    requireBoolean(expanded, "controlmaster", false);
    requireBoolean(expanded, "updatehostkeys", false);
    requireValue(expanded, "identityfile", input.expectedIdentityFile);
    requireValue(expanded, "userknownhostsfile", input.expectedKnownHostsFile);
    requireValue(expanded, "globalknownhostsfile", "/dev/null");
    const connectTimeout = Number(one(expanded, "connecttimeout"));
    const keepalive = Number(one(expanded, "serveraliveinterval"));
    const missedKeepalives = Number(one(expanded, "serveralivecountmax"));
    if (
      !Number.isInteger(connectTimeout) ||
      connectTimeout < 1 ||
      connectTimeout > 10 ||
      !Number.isInteger(keepalive) ||
      keepalive < 1 ||
      keepalive > 30 ||
      !Number.isInteger(missedKeepalives) ||
      missedKeepalives < 1 ||
      missedKeepalives > 3
    ) {
      throw new Error("SSH worker timeout and keepalive policy is unsafe.");
    }
    return sshTransportProofSchema.parse({
      hostId: input.hostId,
      hostname,
      user: input.expectedUser,
      identityFile: input.expectedIdentityFile,
      knownHostsFile: input.expectedKnownHostsFile,
      configSha256: configFile.sha256,
      sshExecutableSha256: ssh.sha256,
    });
  }
}
