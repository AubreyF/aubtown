import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import { ProcessCommandRunner } from "../src/adapters/command-runner.js";
import { OpenSshWorkerPolicyVerifier } from "../src/security/ssh-worker-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

function expanded(overrides: Readonly<Record<string, string>> = {}): string {
  const values: Readonly<Record<string, string>> = {
    hostname: "linux-control-1.tailnet.example",
    user: "aubtown-executor",
    batchmode: "yes",
    stricthostkeychecking: "yes",
    hostkeyalias: "linux-control-1",
    identitiesonly: "yes",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    pubkeyauthentication: "yes",
    preferredauthentications: "publickey",
    gssapiauthentication: "no",
    hostbasedauthentication: "no",
    forwardagent: "no",
    clearallforwardings: "yes",
    requesttty: "false",
    controlmaster: "false",
    updatehostkeys: "false",
    identityfile: "/etc/aubtown/ssh/worker_ed25519",
    userknownhostsfile: "/etc/aubtown/ssh/known_hosts",
    globalknownhostsfile: "/dev/null",
    connecttimeout: "5",
    serveraliveinterval: "15",
    serveralivecountmax: "2",
    ...overrides,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key} ${value}`)
    .join("\n")}\n`;
}

class Runner implements CommandRunner {
  request?: CommandRequest;
  constructor(private readonly output: string) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.request = request;
    return { stdout: this.output, stderr: "" };
  }
}

async function fixture(output = expanded()) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-ssh-policy-")),
  );
  roots.push(root);
  const sshExecutable = path.join(root, "ssh");
  const sshConfig = path.join(root, "config");
  await writeFile(sshExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(sshExecutable, 0o700);
  await writeFile(sshConfig, "Host linux-control-1\n", { mode: 0o600 });
  const runner = new Runner(output);
  return {
    runner,
    verifier: new OpenSshWorkerPolicyVerifier(runner),
    input: {
      sshExecutable,
      sshConfig,
      commandCwd: root,
      hostId: "linux-control-1",
      expectedUser: "aubtown-executor",
      expectedIdentityFile: "/etc/aubtown/ssh/worker_ed25519",
      expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
      requiredConfigUid: process.getuid?.() ?? 0,
    },
  };
}

describe("SSH worker policy", () => {
  it("accepts the checked-in profile after its host placeholders are replaced", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "aubtown-ssh-profile-")),
    );
    roots.push(root);
    const config = path.join(root, "config");
    const template = await readFile(
      path.join(process.cwd(), "config/hosts/ssh_config.example"),
      "utf8",
    );
    await writeFile(
      config,
      template
        .replace("replace-with-linux-tailscale-name-or-address", "127.0.0.1")
        .replace("replace-with-macos-tailscale-name-or-address", "127.0.0.2"),
      { mode: 0o600 },
    );
    const sshExecutable = await realpath(
      process.env.AUBTOWN_TEST_SSH_EXECUTABLE ?? "/usr/bin/ssh",
    );
    await expect(
      new OpenSshWorkerPolicyVerifier(new ProcessCommandRunner()).verify({
        sshExecutable,
        sshConfig: config,
        commandCwd: root,
        hostId: "linux-control-1",
        expectedUser: "aubtown-executor",
        expectedIdentityFile: "/etc/aubtown/ssh/worker_ed25519",
        expectedKnownHostsFile: "/etc/aubtown/ssh/known_hosts",
      }),
    ).resolves.toMatchObject({
      hostId: "linux-control-1",
      hostname: "127.0.0.1",
    });
  });

  it("accepts one pinned noninteractive alias with forwarding disabled", async () => {
    const prepared = await fixture();
    await expect(prepared.verifier.verify(prepared.input)).resolves.toMatchObject({
      hostId: "linux-control-1",
      hostname: "linux-control-1.tailnet.example",
      user: "aubtown-executor",
      identityFile: "/etc/aubtown/ssh/worker_ed25519",
      knownHostsFile: "/etc/aubtown/ssh/known_hosts",
    });
    expect(prepared.runner.request).toMatchObject({
      executable: prepared.input.sshExecutable,
      args: [
        "-G",
        "-F",
        prepared.input.sshConfig,
        "--",
        "linux-control-1",
      ],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
  });

  it("rejects password fallback", async () => {
    const prepared = await fixture(expanded({ passwordauthentication: "yes" }));
    await expect(prepared.verifier.verify(prepared.input)).rejects.toThrow(
      "passwordauthentication no",
    );
  });

  it("rejects placeholder hostnames", async () => {
    const prepared = await fixture(
      expanded({ hostname: "replace-with-linux-tailscale-name-or-address" }),
    );
    await expect(prepared.verifier.verify(prepared.input)).rejects.toThrow(
      "still a placeholder",
    );
  });

  it("rejects a group-writable SSH config", async () => {
    const prepared = await fixture();
    await chmod(prepared.input.sshConfig, 0o620);
    await expect(prepared.verifier.verify(prepared.input)).rejects.toThrow(
      "unsafe type, owner, mode, or size",
    );
  });
});
