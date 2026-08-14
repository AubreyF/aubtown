#!/usr/bin/env node

import path from "node:path";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { buildReleaseBundle } from "../deployment/release-manifest.js";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || !path.isAbsolute(npmCli)) {
  throw new Error("Release bundling requires npm_execpath from the pinned npm CLI.");
}
const result = await buildReleaseBundle({
  repositoryRoot: process.cwd(),
  gitExecutable: process.env.AUBTOWN_GIT_EXECUTABLE ?? "/usr/bin/git",
  nodeExecutable: process.execPath,
  npmCli,
  runner: new ProcessCommandRunner(),
});
process.stdout.write(
  `${JSON.stringify({
    event: "release-bundle-built",
    root: result.root,
    commit: result.manifest.commit,
    platform: result.manifest.platform,
    architecture: result.manifest.architecture,
    fileCount: result.manifest.files.length,
    manifestSha256: result.manifestSha256,
  })}\n`,
);
