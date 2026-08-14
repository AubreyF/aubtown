import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePrivateKeyProvider } from "../src/credentials/file-private-key-provider.js";
import {
  readInstallationTokenFile,
  writeInstallationTokenFile,
} from "../src/credentials/token-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("GitHub App credential files", () => {
  it("writes a synchronized mode-0600 installation token atomically", async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "aubtown-token-"));
    roots.push(root);
    const destination = path.join(root, "github.token");
    await writeInstallationTokenFile({ destination, token: "installation-token" });
    const stats = await lstat(destination);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(destination, "utf8")).toBe("installation-token\n");
    await expect(readInstallationTokenFile(destination)).resolves.toBe(
      "installation-token",
    );
    await chmod(destination, 0o644);
    await expect(readInstallationTokenFile(destination)).rejects.toThrow(
      "protected physical file",
    );
  });

  it("reads only a physical mode-restricted GitHub App private key", async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "aubtown-key-"));
    roots.push(root);
    const key = path.join(root, "app.pem");
    await writeFile(key, "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n", {
      mode: 0o600,
    });
    const provider = new FilePrivateKeyProvider();
    await expect(provider.resolve(key)).resolves.toContain("PRIVATE KEY");
    await chmod(key, 0o644);
    await expect(provider.resolve(key)).rejects.toThrow("mode-restricted");
    await chmod(key, 0o600);
    const alias = path.join(root, "alias.pem");
    await symlink(key, alias);
    await expect(provider.resolve(alias)).rejects.toThrow("symbolic links");
  });
});
