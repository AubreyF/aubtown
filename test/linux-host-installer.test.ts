import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installLinuxHost,
  linuxServiceAccounts,
  linuxSystemdUnits,
  type LinuxAccountIdentity,
  type LinuxAccountManager,
  type LinuxHostInstallPaths,
  type LinuxServiceManager,
} from "../src/deployment/linux-host-installer.js";
import {
  createReleaseManifest,
  writeReleaseManifest,
} from "../src/deployment/release-manifest.js";

const roots: string[] = [];
const commit = "b".repeat(40);

function currentIdentity(): { readonly uid: number; readonly gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Linux installer tests require a POSIX process identity.");
  }
  return { uid, gid };
}

function serviceIdentity(): { readonly uid: number; readonly gid: number } {
  const identity = currentIdentity();
  return {
    uid: identity.uid === 0 ? 1_001 : identity.uid,
    gid: identity.gid === 0 ? 1_001 : identity.gid,
  };
}

class FixtureAccounts implements LinuxAccountManager {
  readonly records = new Map<string, LinuxAccountIdentity>();
  readonly created: string[] = [];
  readonly updated: string[] = [];

  constructor(stateRoot: string, present = true) {
    if (!present) return;
    const identity = serviceIdentity();
    for (const account of linuxServiceAccounts) {
      this.records.set(account.name, {
        name: account.name,
        ...identity,
        home: path.join(stateRoot, account.homeRelative),
        shell: account.shell,
      });
    }
  }

  async inspect(name: string): Promise<LinuxAccountIdentity | null> {
    return this.records.get(name) ?? null;
  }

  async create(input: {
    readonly name: string;
    readonly home: string;
    readonly shell: string;
  }): Promise<LinuxAccountIdentity> {
    const identity = { ...input, ...serviceIdentity() };
    this.records.set(input.name, identity);
    this.created.push(input.name);
    return identity;
  }

  async update(input: {
    readonly current: LinuxAccountIdentity;
    readonly home: string;
    readonly shell: string;
  }): Promise<LinuxAccountIdentity> {
    const identity = {
      ...input.current,
      home: input.home,
      shell: input.shell,
    };
    this.records.set(input.current.name, identity);
    this.updated.push(input.current.name);
    return identity;
  }
}

class FixtureServices implements LinuxServiceManager {
  reloads = 0;
  activeState = "inactive";
  unitFileState = "disabled";
  readonly inspected: string[] = [];

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async inspect(unit: string): Promise<{
    readonly activeState: string;
    readonly unitFileState: string;
  }> {
    this.inspected.push(unit);
    return {
      activeState: this.activeState,
      unitFileState: this.unitFileState,
    };
  }
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly paths: LinuxHostInstallPaths;
  readonly accounts: FixtureAccounts;
  readonly services: FixtureServices;
  readonly input: Parameters<typeof installLinuxHost>[0];
}> {
  const fixtureParent = path.join(process.cwd(), ".aubtown");
  await mkdir(fixtureParent, { recursive: true, mode: 0o700 });
  await chmod(fixtureParent, 0o700);
  const root = await realpath(
    await mkdtemp(path.join(fixtureParent, "linux-installer-")),
  );
  roots.push(root);
  const releasesRoot = path.join(root, "opt", "aubtown", "releases");
  const releaseRoot = path.join(releasesRoot, commit);
  const systemdRoot = path.join(root, "etc", "systemd", "system");
  for (const directory of [
    releasesRoot,
    path.join(root, "etc"),
    systemdRoot,
    path.join(root, "var", "lib"),
    path.join(root, "var", "log"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
  }
  await mkdir(path.join(releaseRoot, "deploy", "systemd"), {
    recursive: true,
    mode: 0o755,
  });
  for (const unit of linuxSystemdUnits) {
    await writeFile(
      path.join(releaseRoot, "deploy", "systemd", unit),
      `[Unit]\nDescription=${unit}\n`,
      { mode: 0o644 },
    );
  }
  await mkdir(path.join(releaseRoot, "config", "hosts"), {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(
    path.join(
      releaseRoot,
      "config",
      "hosts",
      "symphony_ssh_config.example",
    ),
    "Include /etc/aubtown/ssh/config\n",
    { mode: 0o644 },
  );
  const manifest = await createReleaseManifest({
    root: releaseRoot,
    commit,
    platform: "linux",
    architecture: "x64",
    nodeVersion: process.version,
  });
  await writeReleaseManifest({ root: releaseRoot, manifest });
  const paths = {
    releaseRoot,
    releasesRoot,
    activeLink: path.join(root, "opt", "aubtown", "current"),
    systemdRoot,
    configRoot: path.join(root, "etc", "aubtown"),
    stateRoot: path.join(root, "var", "lib", "aubtown"),
    logRoot: path.join(root, "var", "lib", "aubtown", "logs"),
  };
  const accounts = new FixtureAccounts(paths.stateRoot);
  const services = new FixtureServices();
  const identity = currentIdentity();
  const input = {
    mode: "apply" as const,
    platform: "linux",
    callerUid: 0,
    trustedFileUid: identity.uid,
    trustedFileGid: identity.gid,
    expectedArchitecture: "x64",
    expectedNodeVersion: process.version,
    paths,
    accounts,
    services,
  };
  return { root, paths, accounts, services, input };
}

describe("native Linux host installer", () => {
  it("plans without changing the host fixture", async () => {
    const value = await fixture();
    const result = await installLinuxHost({ ...value.input, mode: "plan" });
    expect(result.actions).toContain(
      `activate-release:${value.paths.releaseRoot}`,
    );
    expect(result.actions).toContain(
      `install-unit:${path.join(value.paths.systemdRoot, linuxSystemdUnits[0])}`,
    );
    await expect(lstat(value.paths.configRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(value.paths.activeLink)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(value.services.reloads).toBe(0);
  });

  it("installs one disabled contract and retries idempotently", async () => {
    const value = await fixture();
    const first = await installLinuxHost(value.input);
    expect(first.servicesEnabled).toBe(false);
    expect(first.servicesStarted).toBe(false);
    expect(await readlink(value.paths.activeLink)).toBe(
      value.paths.releaseRoot,
    );
    expect(value.services.reloads).toBe(1);
    expect(value.services.inspected).toEqual([...linuxSystemdUnits]);
    for (const unit of linuxSystemdUnits) {
      expect(
        await readFile(path.join(value.paths.systemdRoot, unit), "utf8"),
      ).toBe(`[Unit]\nDescription=${unit}\n`);
    }
    for (const directory of [
      value.paths.configRoot,
      value.paths.stateRoot,
      value.paths.logRoot,
    ]) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    }
    expect(
      (await lstat(path.join(value.paths.stateRoot, "workspaces"))).mode & 0o777,
    ).toBe(0o750);
    const symphonySshConfig = path.join(
      value.paths.stateRoot,
      "symphony",
      ".ssh",
      "config",
    );
    expect(await readFile(symphonySshConfig, "utf8")).toBe(
      "Include /etc/aubtown/ssh/config\n",
    );
    expect((await lstat(symphonySshConfig)).mode & 0o777).toBe(0o600);

    const second = await installLinuxHost(value.input);
    expect(second.actions).toEqual([]);
    expect(value.services.reloads).toBe(2);
  });

  it("creates missing service identities only during apply", async () => {
    const value = await fixture();
    const accounts = new FixtureAccounts(value.paths.stateRoot, false);
    const planned = await installLinuxHost({
      ...value.input,
      mode: "plan",
      accounts,
    });
    expect(
      planned.actions.filter((action) => action.startsWith("create-account:")),
    ).toHaveLength(linuxServiceAccounts.length);
    expect(accounts.created).toEqual([]);

    await installLinuxHost({ ...value.input, accounts });
    expect(accounts.created).toEqual(
      linuxServiceAccounts.map((account) => account.name),
    );
  });

  it("requires explicit replacement to correct an existing account", async () => {
    const value = await fixture();
    const identity = value.accounts.records.get("aubtown-publisher")!;
    value.accounts.records.set("aubtown-publisher", {
      ...identity,
      home: `${value.paths.stateRoot}-publisher`,
      shell: "/usr/sbin/nologin",
    });
    await expect(installLinuxHost(value.input)).rejects.toThrow(
      "service account differs",
    );
    const planned = await installLinuxHost({
      ...value.input,
      mode: "plan",
      replace: true,
    });
    expect(planned.actions).toContain("update-account:aubtown-publisher");
    expect(value.accounts.updated).toEqual([]);
    await installLinuxHost({ ...value.input, replace: true });
    expect(value.accounts.updated).toEqual(["aubtown-publisher"]);
  });

  it("fails closed on platform, privilege, release, and root drift", async () => {
    const wrongPlatform = await fixture();
    await expect(
      installLinuxHost({ ...wrongPlatform.input, platform: "darwin" }),
    ).rejects.toThrow("supports Linux only");
    await expect(
      installLinuxHost({ ...wrongPlatform.input, callerUid: 501 }),
    ).rejects.toThrow("requires root");

    const tampered = await fixture();
    await writeFile(
      path.join(
        tampered.paths.releaseRoot,
        "deploy",
        "systemd",
        linuxSystemdUnits[0],
      ),
      "tampered\n",
    );
    await expect(installLinuxHost(tampered.input)).rejects.toThrow(
      "differs from its manifest",
    );

    const unsafeRoot = await fixture();
    await chmod(unsafeRoot.paths.releasesRoot, 0o777);
    await expect(installLinuxHost(unsafeRoot.input)).rejects.toThrow(
      "not protected",
    );
  });

  it("requires explicit replacement for changed units and active releases", async () => {
    const value = await fixture();
    await installLinuxHost(value.input);
    const unitPath = path.join(value.paths.systemdRoot, linuxSystemdUnits[0]);
    await writeFile(unitPath, "locally changed\n");
    await expect(installLinuxHost(value.input)).rejects.toThrow(
      "differs from the reviewed release",
    );
    const replaced = await installLinuxHost({ ...value.input, replace: true });
    expect(replaced.actions).toContain(`replace-unit:${unitPath}`);
  });

  it("requires explicit replacement for the Symphony SSH client contract", async () => {
    const value = await fixture();
    await installLinuxHost(value.input);
    const configPath = path.join(
      value.paths.stateRoot,
      "symphony",
      ".ssh",
      "config",
    );
    await writeFile(configPath, "Host *\n", { mode: 0o600 });
    await expect(installLinuxHost(value.input)).rejects.toThrow(
      "private host file differs",
    );
    const replaced = await installLinuxHost({ ...value.input, replace: true });
    expect(replaced.actions).toContain(`replace-private-file:${configPath}`);
  });

  it("refuses to replace an active installed unit", async () => {
    const value = await fixture();
    await installLinuxHost(value.input);
    const unitPath = path.join(value.paths.systemdRoot, linuxSystemdUnits[0]);
    await writeFile(unitPath, "locally changed\n");
    value.services.activeState = "active";
    await expect(
      installLinuxHost({ ...value.input, replace: true }),
    ).rejects.toThrow("not disabled and inactive");
    expect(await readFile(unitPath, "utf8")).toBe("locally changed\n");
  });
});
