#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { shadowInputSchema } from "../domain/schemas.js";
import { qualifyIssues } from "../qualification/pipeline.js";

function issuePath(argv: readonly string[]): string {
  const index = argv.indexOf("--issues");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("Usage: npm run shadow -- --issues <fixture.json>");
  }
  return resolve(value);
}

async function main(): Promise<void> {
  const path = issuePath(process.argv.slice(2));
  const input = shadowInputSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const reports = qualifyIssues({
    repository: input.repository,
    candidates: input.issues,
    requireExecutionAuthority: false,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "read-only-shadow",
        generatedAt: new Date().toISOString(),
        repository: input.repository,
        reports,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
