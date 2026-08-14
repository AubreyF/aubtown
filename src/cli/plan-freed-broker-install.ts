#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { ProcessCommandRunner } from "../adapters/command-runner.js";
import { planFreedBrokerInstallation } from "../deployment/freed-broker-install-plan.js";

function parseArguments(values: readonly string[]): {
  readonly freedRoot: string;
  readonly freedCommit: string;
  readonly releaseRoot: string;
} {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      value === undefined ||
      !["--freed-root", "--freed-commit", "--release-root"].includes(
        name ?? "",
      ) ||
      parsed.has(name!)
    ) {
      throw new Error(
        "Usage: plan-freed-broker-install --freed-root <absolute-path> --freed-commit <full-sha> --release-root <absolute-path>",
      );
    }
    parsed.set(name!, value);
  }
  const freedRoot = parsed.get("--freed-root");
  const freedCommit = parsed.get("--freed-commit");
  const releaseRoot = parsed.get("--release-root");
  if (
    parsed.size !== 3 ||
    freedRoot === undefined ||
    freedCommit === undefined ||
    releaseRoot === undefined
  ) {
    throw new Error(
      "Usage: plan-freed-broker-install --freed-root <absolute-path> --freed-commit <full-sha> --release-root <absolute-path>",
    );
  }
  return { freedRoot, freedCommit, releaseRoot };
}

const callerUid = process.getuid?.();
if (callerUid !== 0) {
  throw new Error("Production broker installation planning requires root.");
}
const command = parseArguments(process.argv.slice(2));
const nodeExecutable = await realpath("/opt/aubtown/node/bin/node");
const plan = await planFreedBrokerInstallation({
  runner: new ProcessCommandRunner(),
  gitExecutable: await realpath("/usr/bin/git"),
  trustedUid: 0,
  expectedPlatform: process.platform,
  expectedArchitecture: process.arch,
  expectedNodeVersion: process.version,
  freedCommit: command.freedCommit,
  freedRepositoryRoot: command.freedRoot,
  freedStateRoot: "/var/lib/freed/automation",
  aubtownReleaseRoot: command.releaseRoot,
  nodeExecutable,
  brokerDestination: "/opt/freed/bin/factory-coordinator",
  profileDestination:
    "/etc/aubtown/freed-broker-profiles/freed-pilot.json",
});
process.stdout.write(`${JSON.stringify(plan)}\n`);
