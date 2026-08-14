#!/usr/bin/env node

import path from "node:path";
import { verifyInstalledRelease } from "../deployment/release-manifest.js";

const root = process.argv[2];
if (root === undefined || !path.isAbsolute(root)) {
  throw new Error("Release verification requires one absolute release root.");
}
const result = await verifyInstalledRelease({
  root,
  requiredUid: 0,
});
process.stdout.write(
  `${JSON.stringify({
    event: "release-install-verified",
    root,
    commit: result.manifest.commit,
    platform: result.manifest.platform,
    architecture: result.manifest.architecture,
    fileCount: result.manifest.files.length,
    manifestSha256: result.sha256,
  })}\n`,
);
