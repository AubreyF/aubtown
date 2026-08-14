process.stderr.write(
  `${JSON.stringify({
    status: "blocked",
    reason: "workspace-was-not-prepared-through-freed-helper",
    workspace: process.cwd(),
  })}\n`,
);
process.exitCode = 1;
