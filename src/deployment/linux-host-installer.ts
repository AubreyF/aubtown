import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { verifyInstalledRelease } from "./release-manifest.js";

export const linuxServiceAccounts = [
  {
    name: "aubtown-symphony",
    homeRelative: "symphony",
    shell: "/usr/sbin/nologin",
  },
  {
    name: "aubtown-executor",
    homeRelative: "executor",
    shell: "/bin/bash",
  },
  {
    name: "aubtown-publisher",
    homeRelative: "publisher",
    shell: "/bin/bash",
  },
  {
    name: "aubtown-checkpoint",
    homeRelative: "checkpoints",
    shell: "/usr/sbin/nologin",
  },
] as const;

export const linuxSystemdUnits = [
  "aubtown-checkpoint-edge.service",
  "aubtown-claim-reconciliation.service",
  "aubtown-claim-reconciliation.timer",
  "aubtown-completion-reconciliation.service",
  "aubtown-completion-reconciliation.timer",
  "aubtown-freed-broker-conformance.service",
  "aubtown-github-token.service",
  "aubtown-github-token.timer",
  "aubtown-host-agent.service",
  "aubtown-host-gateway.service",
  "aubtown-pilot-readiness.service",
  "aubtown-planning-snapshot.service",
  "aubtown-planning-snapshot.timer",
  "aubtown-symphony.service",
] as const;

export interface LinuxAccountIdentity {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly shell: string;
}

export interface LinuxAccountManager {
  inspect(name: string): Promise<LinuxAccountIdentity | null>;
  create(input: {
    readonly name: string;
    readonly home: string;
    readonly shell: string;
  }): Promise<LinuxAccountIdentity>;
  update(input: {
    readonly current: LinuxAccountIdentity;
    readonly home: string;
    readonly shell: string;
  }): Promise<LinuxAccountIdentity>;
}

export interface LinuxServiceManager {
  reload(): Promise<void>;
  inspect(unit: string): Promise<{
    readonly activeState: string;
    readonly unitFileState: string;
  } | null>;
}

export interface LinuxHostInstallPaths {
  readonly releaseRoot: string;
  readonly releasesRoot: string;
  readonly activeLink: string;
  readonly systemdRoot: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly logRoot: string;
}

export interface LinuxHostInstallResult {
  readonly mode: "plan" | "apply";
  readonly releaseCommit: string;
  readonly releaseManifestSha256: string;
  readonly actions: readonly string[];
  readonly units: readonly string[];
  readonly servicesEnabled: false;
  readonly servicesStarted: false;
}

interface DirectoryContract {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

function physicalChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function modeOf(value: number): number {
  return value & 0o777;
}

async function inspectProtectedDirectory(
  directory: string,
  trustedUid: number,
): Promise<void> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error(
      `Host directory is not canonical and absolute: ${directory}`,
    );
  }
  let current = directory;
  while (true) {
    const physical = await realpath(current);
    const stats = await lstat(current);
    if (
      physical !== current ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.uid !== 0 && stats.uid !== trustedUid) ||
      modeOf(stats.mode) & 0o022
    ) {
      throw new Error(`Host directory is not protected: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectory(
  contract: DirectoryContract,
  mode: "plan" | "apply",
  actions: string[],
): Promise<void> {
  if (!(await pathExists(contract.path))) {
    actions.push(`create-directory:${contract.path}`);
    if (mode === "plan") return;
    await mkdir(contract.path, { mode: contract.mode });
    await chown(contract.path, contract.uid, contract.gid);
    await chmod(contract.path, contract.mode);
  }
  const stats = await lstat(contract.path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== contract.uid ||
    stats.gid !== contract.gid ||
    modeOf(stats.mode) !== contract.mode
  ) {
    throw new Error(
      `Installed host directory differs from its contract: ${contract.path}`,
    );
  }
}

async function installUnit(input: {
  readonly source: string;
  readonly destination: string;
  readonly trustedUid: number;
  readonly trustedGid: number;
  readonly mode: "plan" | "apply";
  readonly replace: boolean;
  readonly actions: string[];
}): Promise<void> {
  const sourceBytes = await readFile(input.source);
  if (await pathExists(input.destination)) {
    const stats = await lstat(input.destination);
    const destinationBytes = stats.isFile()
      ? await readFile(input.destination)
      : Buffer.alloc(0);
    const exact =
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.uid === input.trustedUid &&
      stats.gid === input.trustedGid &&
      modeOf(stats.mode) === 0o644 &&
      destinationBytes.equals(sourceBytes);
    if (exact) return;
    if (!input.replace) {
      throw new Error(
        `Installed systemd unit differs from the reviewed release: ${input.destination}`,
      );
    }
    input.actions.push(`replace-unit:${input.destination}`);
  } else {
    input.actions.push(`install-unit:${input.destination}`);
  }
  if (input.mode === "plan") return;
  const temporary = `${input.destination}.aubtown-installing`;
  await rm(temporary, { force: true });
  try {
    await copyFile(input.source, temporary);
    await chown(temporary, input.trustedUid, input.trustedGid);
    await chmod(temporary, 0o644);
    await rename(temporary, input.destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function installPrivateFile(input: {
  readonly source: string;
  readonly destination: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: "plan" | "apply";
  readonly replace: boolean;
  readonly actions: string[];
}): Promise<void> {
  const sourceBytes = await readFile(input.source);
  if (await pathExists(input.destination)) {
    const stats = await lstat(input.destination);
    const destinationBytes = stats.isFile()
      ? await readFile(input.destination)
      : Buffer.alloc(0);
    const exact =
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.uid === input.uid &&
      stats.gid === input.gid &&
      modeOf(stats.mode) === 0o600 &&
      destinationBytes.equals(sourceBytes);
    if (exact) return;
    if (!input.replace) {
      throw new Error(
        `Installed private host file differs from the reviewed release: ${input.destination}`,
      );
    }
    input.actions.push(`replace-private-file:${input.destination}`);
  } else {
    input.actions.push(`install-private-file:${input.destination}`);
  }
  if (input.mode === "plan") return;
  const temporary = `${input.destination}.aubtown-installing`;
  await rm(temporary, { force: true });
  try {
    await copyFile(input.source, temporary);
    await chown(temporary, input.uid, input.gid);
    await chmod(temporary, 0o600);
    await rename(temporary, input.destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function activateRelease(input: {
  readonly releaseRoot: string;
  readonly activeLink: string;
  readonly mode: "plan" | "apply";
  readonly replace: boolean;
  readonly actions: string[];
}): Promise<void> {
  if (await pathExists(input.activeLink)) {
    const stats = await lstat(input.activeLink);
    const exact =
      stats.isSymbolicLink() &&
      path.resolve(
        path.dirname(input.activeLink),
        await readlink(input.activeLink),
      ) === input.releaseRoot;
    if (exact) return;
    if (!input.replace) {
      throw new Error("The active AubTown release points somewhere else.");
    }
    input.actions.push(`replace-active-release:${input.releaseRoot}`);
  } else {
    input.actions.push(`activate-release:${input.releaseRoot}`);
  }
  if (input.mode === "plan") return;
  const temporary = `${input.activeLink}.aubtown-installing`;
  await rm(temporary, { force: true });
  try {
    await symlink(input.releaseRoot, temporary);
    await rename(temporary, input.activeLink);
  } finally {
    await rm(temporary, { force: true });
  }
}

function accountMatches(
  identity: LinuxAccountIdentity,
  expected: {
    readonly name: string;
    readonly home: string;
    readonly shell: string;
  },
): boolean {
  return !(
    identity.name !== expected.name ||
    !Number.isSafeInteger(identity.uid) ||
    identity.uid <= 0 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid <= 0 ||
    identity.home !== expected.home ||
    identity.shell !== expected.shell
  );
}

export async function installLinuxHost(input: {
  readonly mode: "plan" | "apply";
  readonly replace?: boolean;
  readonly platform: string;
  readonly callerUid: number;
  readonly trustedFileUid: number;
  readonly trustedFileGid: number;
  readonly expectedArchitecture: string;
  readonly expectedNodeVersion: string;
  readonly paths: LinuxHostInstallPaths;
  readonly accounts: LinuxAccountManager;
  readonly services: LinuxServiceManager;
}): Promise<LinuxHostInstallResult> {
  if (input.platform !== "linux") {
    throw new Error("The native AubTown host installer supports Linux only.");
  }
  if (input.mode === "apply" && input.callerUid !== 0) {
    throw new Error("Applying the Linux host contract requires root.");
  }
  const paths = Object.values(input.paths);
  if (
    paths.some(
      (value) => !path.isAbsolute(value) || path.normalize(value) !== value,
    )
  ) {
    throw new Error(
      "Every Linux host installation path must be canonical and absolute.",
    );
  }
  await inspectProtectedDirectory(
    input.paths.releasesRoot,
    input.trustedFileUid,
  );
  await inspectProtectedDirectory(
    path.dirname(input.paths.activeLink),
    input.trustedFileUid,
  );
  await inspectProtectedDirectory(
    input.paths.systemdRoot,
    input.trustedFileUid,
  );
  await inspectProtectedDirectory(
    path.dirname(input.paths.configRoot),
    input.trustedFileUid,
  );
  await inspectProtectedDirectory(
    path.dirname(input.paths.stateRoot),
    input.trustedFileUid,
  );
  if (!physicalChild(input.paths.stateRoot, input.paths.logRoot)) {
    await inspectProtectedDirectory(
      path.dirname(input.paths.logRoot),
      input.trustedFileUid,
    );
  }
  if (!physicalChild(input.paths.releasesRoot, input.paths.releaseRoot)) {
    throw new Error(
      "The release is outside the immutable AubTown release root.",
    );
  }
  const release = await verifyInstalledRelease({
    root: input.paths.releaseRoot,
    requiredUid: input.trustedFileUid,
    expectedPlatform: "linux",
    expectedArchitecture: input.expectedArchitecture,
    expectedNodeVersion: input.expectedNodeVersion,
  });
  for (const unit of linuxSystemdUnits) {
    const destination = path.join(input.paths.systemdRoot, unit);
    if (!(await pathExists(destination))) continue;
    const state = await input.services.inspect(unit);
    if (
      state === null ||
      state.activeState !== "inactive" ||
      !["disabled", "static"].includes(state.unitFileState)
    ) {
      throw new Error(
        `Existing systemd unit is not disabled and inactive: ${unit}`,
      );
    }
  }
  const actions: string[] = [];
  const identities = new Map<string, LinuxAccountIdentity>();
  const accountContracts = linuxServiceAccounts.map((account) => ({
    name: account.name,
    home: path.join(input.paths.stateRoot, account.homeRelative),
    shell: account.shell,
  }));
  for (const account of accountContracts) {
    let identity = await input.accounts.inspect(account.name);
    if (identity === null) {
      actions.push(`create-account:${account.name}`);
      if (input.mode === "apply") {
        identity = await input.accounts.create(account);
      }
    }
    if (identity !== null) {
      if (!accountMatches(identity, account)) {
        if (!(input.replace ?? false)) {
          throw new Error(
            `Linux service account differs from its contract: ${account.name}`,
          );
        }
        actions.push(`update-account:${account.name}`);
        if (input.mode === "apply") {
          identity = await input.accounts.update({
            current: identity,
            home: account.home,
            shell: account.shell,
          });
        } else {
          identity = { ...identity, home: account.home, shell: account.shell };
        }
      }
      if (!accountMatches(identity, account)) {
        throw new Error(
          `Linux service account differs from its contract: ${account.name}`,
        );
      }
      identities.set(account.name, identity);
    }
  }
  const rootIdentity = {
    uid: input.trustedFileUid,
    gid: input.trustedFileGid,
  };
  const directoryContracts: DirectoryContract[] = [
    { path: input.paths.configRoot, ...rootIdentity, mode: 0o755 },
    { path: input.paths.stateRoot, ...rootIdentity, mode: 0o755 },
    { path: input.paths.logRoot, ...rootIdentity, mode: 0o755 },
  ];
  for (const account of accountContracts) {
    const identity = identities.get(account.name);
    if (identity !== undefined) {
      directoryContracts.push({
        path: account.home,
        uid: identity.uid,
        gid: identity.gid,
        mode: 0o700,
      });
    }
  }
  const symphony = identities.get("aubtown-symphony");
  const executor = identities.get("aubtown-executor");
  if (symphony !== undefined) {
    for (const relative of ["admission", "coordinator", "conformance"]) {
      directoryContracts.push({
        path: path.join(input.paths.stateRoot, relative),
        uid: symphony.uid,
        gid: symphony.gid,
        mode: 0o700,
      });
    }
    directoryContracts.push({
      path: path.join(input.paths.logRoot, "symphony"),
      uid: symphony.uid,
      gid: symphony.gid,
      mode: 0o700,
    });
    directoryContracts.push({
      path: path.join(input.paths.stateRoot, "symphony", ".ssh"),
      uid: symphony.uid,
      gid: symphony.gid,
      mode: 0o700,
    });
  }
  if (executor !== undefined) {
    directoryContracts.push({
      path: path.join(input.paths.stateRoot, "workspaces"),
      uid: executor.uid,
      gid: executor.gid,
      mode: 0o750,
    });
  }
  for (const relative of ["keys", "ssh"]) {
    directoryContracts.push({
      path: path.join(input.paths.configRoot, relative),
      ...rootIdentity,
      mode: 0o755,
    });
  }
  const publisher = identities.get("aubtown-publisher");
  if (publisher !== undefined) {
    directoryContracts.push({
      path: path.join(input.paths.configRoot, "publisher"),
      uid: publisher.uid,
      gid: publisher.gid,
      mode: 0o700,
    });
  }
  for (const contract of directoryContracts) {
    await ensureDirectory(contract, input.mode, actions);
  }
  if (symphony !== undefined) {
    await installPrivateFile({
      source: path.join(
        input.paths.releaseRoot,
        "config",
        "hosts",
        "symphony_ssh_config.example",
      ),
      destination: path.join(
        input.paths.stateRoot,
        "symphony",
        ".ssh",
        "config",
      ),
      uid: symphony.uid,
      gid: symphony.gid,
      mode: input.mode,
      replace: input.replace ?? false,
      actions,
    });
  }
  for (const unit of linuxSystemdUnits) {
    await installUnit({
      source: path.join(input.paths.releaseRoot, "deploy", "systemd", unit),
      destination: path.join(input.paths.systemdRoot, unit),
      trustedUid: input.trustedFileUid,
      trustedGid: input.trustedFileGid,
      mode: input.mode,
      replace: input.replace ?? false,
      actions,
    });
  }
  await activateRelease({
    releaseRoot: input.paths.releaseRoot,
    activeLink: input.paths.activeLink,
    mode: input.mode,
    replace: input.replace ?? false,
    actions,
  });
  if (input.mode === "apply") {
    await input.services.reload();
    for (const unit of linuxSystemdUnits) {
      const state = await input.services.inspect(unit);
      if (
        state === null ||
        state.activeState !== "inactive" ||
        !["disabled", "static"].includes(state.unitFileState)
      ) {
        throw new Error(
          `Installed systemd unit is not disabled and inactive: ${unit}`,
        );
      }
    }
  }
  return {
    mode: input.mode,
    releaseCommit: release.manifest.commit,
    releaseManifestSha256: release.sha256,
    actions,
    units: linuxSystemdUnits,
    servicesEnabled: false,
    servicesStarted: false,
  };
}
