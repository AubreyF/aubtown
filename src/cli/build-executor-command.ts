import { readFile } from "node:fs/promises";
import { createExecutorStartCommand } from "../execution/command.js";

const inputFile = process.argv[2];
if (inputFile === undefined || !inputFile.startsWith("/")) {
  throw new Error("Provide one absolute executor command input path.");
}

const input = JSON.parse(await readFile(inputFile, "utf8")) as Parameters<
  typeof createExecutorStartCommand
>[0];
process.stdout.write(`${JSON.stringify(createExecutorStartCommand(input))}\n`);
