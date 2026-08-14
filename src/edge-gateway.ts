import { createHostEdgeServer } from "./gateway/edge-server.js";
import { parseBindHost, parseServicePort } from "./config/network.js";

const port = parseServicePort(process.env.PORT, 8_090);
const bindHost = parseBindHost(process.env.FREEDWORKS_BIND_HOST);
const restateIngress = process.env.FREEDWORKS_RESTATE_INGRESS?.trim();
if (restateIngress === undefined || restateIngress.length === 0) {
  throw new Error("FREEDWORKS_RESTATE_INGRESS is required.");
}
const server = createHostEdgeServer({ restateIngress });
server.listen(port, bindHost, () => {
  process.stdout.write(
    `Freedworks host edge listening on ${bindHost}:${port.toLocaleString()}.\n`,
  );
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
