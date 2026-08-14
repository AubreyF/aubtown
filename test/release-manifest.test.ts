import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandRunner,
} from "../src/adapters/command-runner.js";
import {
  buildReleaseBundle,
  createReleaseManifest,
  verifyInstalledRelease,
  writeReleaseManifest,
} from "../src/deployment/release-manifest.js";

const roots: string[] = [];
const commit = "a".repeat(40);

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Release tests require a POSIX user identity.");
  }
  return uid;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) =>
      await rm(root, { recursive: true, force: true })
    ),
  );
});

async function releaseFixture(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "aubtown-release-manifest-")),
  );
  roots.push(parent);
  const root = path.join(parent, commit);
  await mkdir(path.join(root, "dist"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(root, "node_modules", "zod"), {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(path.join(root, "dist", "main.js"), "export {};\n", {
    mode: 0o644,
  });
  await writeFile(
    path.join(root, "node_modules", "zod", "package.json"),
    '{"name":"zod"}\n',
    { mode: 0o644 },
  );
  const manifest = await createReleaseManifest({ root, commit });
  await writeReleaseManifest({ root, manifest });
  return root;
}

describe("immutable release manifest", () => {
  it("proves the exact host-specific file set", async () => {
    const root = await releaseFixture();
    const result = await verifyInstalledRelease({
      root,
      requiredUid: currentUid(),
    });
    expect(result.manifest).toMatchObject({
      commit,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    });
    expect(result.manifest.files.map((file) => file.path)).toEqual([
      "dist/main.js",
      "node_modules/zod/package.json",
    ]);
  });

  it("rejects changed and unexpected files", async () => {
    const changed = await releaseFixture();
    await writeFile(path.join(changed, "dist", "main.js"), "changed\n", {
      mode: 0o644,
    });
    await expect(
      verifyInstalledRelease({ root: changed, requiredUid: currentUid() }),
    ).rejects.toThrow("differs from its manifest");

    const unexpected = await releaseFixture();
    await writeFile(path.join(unexpected, "extra.js"), "extra\n", { mode: 0o644 });
    await expect(
      verifyInstalledRelease({ root: unexpected, requiredUid: currentUid() }),
    ).rejects.toThrow("file set differs");
  });

  it("rejects symlinks and writable directories", async () => {
    const linked = await releaseFixture();
    await symlink("main.js", path.join(linked, "dist", "alias.js"));
    await expect(
      verifyInstalledRelease({ root: linked, requiredUid: currentUid() }),
    ).rejects.toThrow("symbolic link");

    const writable = await releaseFixture();
    await chmod(path.join(writable, "dist"), 0o775);
    await expect(
      verifyInstalledRelease({ root: writable, requiredUid: currentUid() }),
    ).rejects.toThrow("directory is not protected");
  });

  it("builds only tracked runtime assets and locked production dependencies", async () => {
    const repositoryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "aubtown-release-source-")),
    );
    roots.push(repositoryRoot);
    const files: Record<string, string> = {
      ".nvmrc": "24.14.1\n",
      "AGENTS.md": "instructions\n",
      "README.md": "# AubTown\n",
      "package.json": '{"name":"@aubtown/control-plane","version":"0.1.0"}\n',
      "package-lock.json": '{"lockfileVersion":3}\n',
      "config/symphony/freed.WORKFLOW.md": "workflow\n",
      "deploy/systemd/aubtown.service": "service\n",
      "docs/DEPLOYMENT.md": "deployment\n",
      "upstream/symphony.lock.json": "{}\n",
      "src/not-runtime.ts": "export {};\n",
      "dist/cli/main.js": "export {};\n",
      "dist/factory-coordinator": "binary\n",
    };
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(repositoryRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode: 0o644 });
    }
    const tracked = Object.keys(files)
      .filter((file) => !file.startsWith("dist/") && file !== "src/not-runtime.ts")
      .join("\0");
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = {
      run: async (request) => {
        calls.push(request);
        if (request.executable === "/usr/bin/git") {
          if (request.args[0] === "status") return { stdout: "", stderr: "" };
          if (request.args[0] === "rev-parse") {
            return { stdout: `${commit}\n`, stderr: "" };
          }
          if (request.args[0] === "ls-files") {
            return { stdout: `${tracked}\0`, stderr: "" };
          }
        }
        await mkdir(path.join(request.cwd, "node_modules", "zod"), {
          recursive: true,
        });
        await writeFile(
          path.join(request.cwd, "node_modules", "zod", "package.json"),
          '{"name":"zod"}\n',
        );
        return { stdout: "", stderr: "" };
      },
    };
    const result = await buildReleaseBundle({
      repositoryRoot,
      outputParent: path.join(repositoryRoot, ".aubtown", "releases"),
      gitExecutable: "/usr/bin/git",
      nodeExecutable: process.execPath,
      npmCli: "/opt/npm/npm-cli.js",
      runner,
    });

    expect(result.root).toBe(
      path.join(repositoryRoot, ".aubtown", "releases", commit),
    );
    expect(result.manifest.files.some((file) => file.path === "src/not-runtime.ts"))
      .toBe(false);
    expect(
      result.manifest.files.some(
        (file) => file.path === "node_modules/zod/package.json",
      ),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(result.root, "release-manifest.json"), "utf8")),
    ).toEqual(result.manifest);
    expect(calls.at(-1)?.args).toContain("--omit=dev");
    expect(calls.at(-1)?.args).toContain("--ignore-scripts");
  });
});
