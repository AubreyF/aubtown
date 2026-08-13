import { createHostEdgeServer } from "./gateway/edge-server.js";

const port = Number(process.env.PORT ?? "8090");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 through 65,535.");
}
const restateIngress = process.env.FREEDWORKS_RESTATE_INGRESS?.trim();
if (restateIngress === undefined || restateIngress.length === 0) {
  throw new Error("FREEDWORKS_RESTATE_INGRESS is required.");
}
const server = createHostEdgeServer({ restateIngress });
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Freedworks host edge listening on ${port.toLocaleString()}.\n`);
});

function stop(): void {
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
