#!/usr/bin/env node

import path from "node:path";
import {
  loadGitHubAppPolicy,
  renderGitHubAppRegistration,
} from "../config/github-app-registration.js";

const role = process.argv[2];
if (role !== "coordinator" && role !== "draft-publisher") {
  throw new Error("GitHub App registration role must be coordinator or draft-publisher.");
}
const file = path.join(
  process.cwd(),
  "config",
  "github-apps",
  `${role}.json`,
);
const registration = renderGitHubAppRegistration(
  await loadGitHubAppPolicy(file),
);
process.stdout.write(`${JSON.stringify(registration)}\n`);
