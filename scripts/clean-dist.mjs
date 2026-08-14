import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = await realpath(process.cwd());
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "@aubtown/control-plane") {
  throw new Error("Refusing to clean dist outside the AubTown repository.");
}
const target = path.join(repositoryRoot, "dist");
if (path.dirname(target) !== repositoryRoot || path.basename(target) !== "dist") {
  throw new Error("AubTown dist target is invalid.");
}
await rm(target, { recursive: true, force: true });
