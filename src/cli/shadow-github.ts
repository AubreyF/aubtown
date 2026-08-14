#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import { GitHubIssueSource } from "../adapters/github/issue-source.js";
import { parseDebtIssueBody } from "../adapters/github/issue-parser.js";
import type { RepositoryRef } from "../domain/types.js";
import { qualifyIssues } from "../qualification/pipeline.js";

function option(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? fallback : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(): Promise<void> {
  const token = process.env.AUBTOWN_GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("AUBTOWN_GITHUB_TOKEN is required for host-side read access.");
  }
  const argv = process.argv.slice(2);
  const repository: RepositoryRef = {
    owner: option(argv, "--owner", "freed-project"),
    name: option(argv, "--repo", "freed"),
    defaultBranch: option(argv, "--branch", "dev"),
  };
  const octokit = new Octokit({ auth: token });
  const source = new GitHubIssueSource(octokit.rest.issues);
  const issues = await source.readOpenDebt(repository);
  const reports = qualifyIssues({
    repository,
    candidates: issues.map((issue) => ({
      issue,
      evidence: parseDebtIssueBody(issue.body),
    })),
    requireExecutionAuthority: false,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "read-only-github-shadow",
        generatedAt: new Date().toISOString(),
        repository,
        issueCount: issues.length,
        reports,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
