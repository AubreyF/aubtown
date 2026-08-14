#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const lockPath = path.join(root, "upstream", "symphony.lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (
  lock.schemaVersion !== 1 ||
  lock.repository !== "https://github.com/openai/symphony.git" ||
  !commitPattern.test(lock.production?.commit ?? "") ||
  !digestPattern.test(lock.production?.sourceSha256 ?? "") ||
  lock.tracking?.ref !== "refs/heads/main" ||
  !commitPattern.test(lock.releaseBaseline?.commit ?? "") ||
  !Array.isArray(lock.reviewedCapabilities) ||
  !Array.isArray(lock.knownGaps)
) {
  fail("Symphony lock file is invalid.");
  process.exit();
}

const result = {
  status: "lock-valid",
  productionCommit: lock.production.commit,
  releaseBaseline: lock.releaseBaseline.tag,
};

if (!process.argv.includes("--network")) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit();
}

const { stdout } = await execFileAsync(
  "git",
  ["ls-remote", lock.repository, lock.tracking.ref],
  { maxBuffer: 1024 * 1024 },
);
const [upstreamCommit, upstreamRef] = stdout.trim().split(/\s+/u);
if (!commitPattern.test(upstreamCommit ?? "") || upstreamRef !== lock.tracking.ref) {
  fail("Symphony upstream did not return the expected main reference.");
  process.exit();
}
process.stdout.write(
  `${JSON.stringify({
    ...result,
    status:
      upstreamCommit === lock.production.commit
        ? "production-current"
        : "update-available",
    upstreamCommit,
  })}\n`,
);
