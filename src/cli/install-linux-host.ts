#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  installLinuxHost,
  type LinuxAccountIdentity,
  type LinuxAccountManager,
  type LinuxServiceManager,
} from "../deployment/linux-host-installer.js";

const execFileAsync = promisify(execFile);

function parseArguments(values: readonly string[]): {
  readonly mode: "plan" | "apply";
  readonly releaseRoot: string;
  readonly replace: boolean;
} {
  let mode: "plan" | "apply" | undefined;
  let releaseRoot: string | undefined;
  let replace = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--plan" || value === "--apply") {
      if (mode !== undefined)
        throw new Error("Choose exactly one installer mode.");
      mode = value === "--plan" ? "plan" : "apply";
      continue;
    }
    if (value === "--replace") {
      if (replace)
        throw new Error("The replace flag was provided more than once.");
      replace = true;
      continue;
    }
    if (value === "--release-root" && releaseRoot === undefined) {
      releaseRoot = values[index + 1];
      index += 1;
      continue;
    }
    throw new Error(
      `Unsupported Linux host installer argument: ${value ?? "missing"}`,
    );
  }
  if (mode === undefined || releaseRoot === undefined) {
    throw new Error(
      "Usage: install-linux-host --plan|--apply --release-root <absolute-path> [--replace]",
    );
  }
  return { mode, releaseRoot, replace };
}

async function run(
  executable: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1_024,
  });
  return result.stdout.trim();
}

function parseAccount(line: string): LinuxAccountIdentity {
  const fields = line.split(":");
  const uid = Number.parseInt(fields[2] ?? "", 10);
  const gid = Number.parseInt(fields[3] ?? "", 10);
  const name = fields[0] ?? "";
  const home = fields[5] ?? "";
  const shell = fields[6] ?? "";
  if (
    fields.length !== 7 ||
    name === "" ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid)
  ) {
    throw new Error("Linux account lookup returned an invalid record.");
  }
  return { name, uid, gid, home, shell };
}

const accounts: LinuxAccountManager = {
  inspect: async (name) => {
    try {
      return parseAccount(await run("/usr/bin/getent", ["passwd", name]));
    } catch (error) {
      if ((error as { readonly code?: string | number }).code === 2)
        return null;
      throw error;
    }
  },
  create: async (input) => {
    await run("/usr/sbin/useradd", [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      input.home,
      "--shell",
      input.shell,
      input.name,
    ]);
    return parseAccount(await run("/usr/bin/getent", ["passwd", input.name]));
  },
  update: async (input) => {
    await run("/usr/sbin/usermod", [
      "--home",
      input.home,
      "--shell",
      input.shell,
      input.current.name,
    ]);
    return parseAccount(
      await run("/usr/bin/getent", ["passwd", input.current.name]),
    );
  },
};

const services: LinuxServiceManager = {
  reload: async () => {
    await run("/usr/bin/systemctl", ["daemon-reload"]);
  },
  inspect: async (unit) => {
    const loadState = await run("/usr/bin/systemctl", [
      "show",
      "--property=LoadState",
      "--value",
      unit,
    ]);
    if (loadState === "not-found") return null;
    if (loadState !== "loaded") {
      throw new Error(
        `Systemd returned an unsafe load state for ${unit}: ${loadState}`,
      );
    }
    return {
      activeState: await run("/usr/bin/systemctl", [
        "show",
        "--property=ActiveState",
        "--value",
        unit,
      ]),
      unitFileState: await run("/usr/bin/systemctl", [
        "show",
        "--property=UnitFileState",
        "--value",
        unit,
      ]),
    };
  },
};

const command = parseArguments(process.argv.slice(2));
const callerUid = process.getuid?.();
const callerGid = process.getgid?.();
if (callerUid === undefined || callerGid === undefined) {
  throw new Error(
    "The Linux host installer requires a POSIX process identity.",
  );
}
const result = await installLinuxHost({
  mode: command.mode,
  replace: command.replace,
  platform: process.platform,
  callerUid,
  trustedFileUid: 0,
  trustedFileGid: 0,
  expectedArchitecture: process.arch,
  expectedNodeVersion: process.version,
  paths: {
    releaseRoot: command.releaseRoot,
    releasesRoot: "/opt/aubtown/releases",
    activeLink: "/opt/aubtown/current",
    systemdRoot: "/etc/systemd/system",
    configRoot: "/etc/aubtown",
    stateRoot: "/var/lib/aubtown",
    logRoot: "/var/lib/aubtown/logs",
  },
  accounts,
  services,
});
process.stdout.write(
  `${JSON.stringify({ event: "linux-host-install", ...result })}\n`,
);
