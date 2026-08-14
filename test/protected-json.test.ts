import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProtectedJsonFile,
  writeProtectedJsonFile,
} from "../src/security/protected-json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("protected JSON", () => {
  it("atomically writes a mode-0600 report under a mode-0700 directory", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "aubtown-protected-json-")),
    );
    roots.push(root);
    const file = path.join(root, "planning", "snapshot.json");
    await writeProtectedJsonFile({
      file,
      label: "Planning snapshot",
      value: { safe: false },
    });
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, "utf8")).toBe('{"safe":false}\n');
    await expect(
      loadProtectedJsonFile({ file, label: "Planning snapshot" }),
    ).resolves.toEqual({ safe: false });
    await chmod(file, 0o666);
    await expect(
      loadProtectedJsonFile({ file, label: "Planning snapshot" }),
    ).rejects.toThrow("protected physical file");
  });
});
