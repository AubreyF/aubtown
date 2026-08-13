import { describe, expect, it } from "vitest";
import { StdioJsonRpcTransport } from "../src/drivers/codex/app-server-client.js";

const collisionProbe = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
let requestId;
process.stderr.write("diagnostic stream drained\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "probe") {
    requestId = message.id;
    process.stdout.write(JSON.stringify({
      id: requestId,
      method: "client/unsupported",
      params: {},
    }) + "\n");
    return;
  }
  if (message.id === requestId && message.error?.code === -32601) {
    process.stdout.write(JSON.stringify({
      id: requestId,
      result: { serverRequestRejected: true },
    }) + "\n");
  }
});
`;

describe("Codex app-server stdio transport", () => {
  it("reports an unexpected child exit to late failure subscribers", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    });
    const failure = await new Promise<Error>((resolve) => {
      transport.onFailure(resolve);
    });
    expect(failure.message).toContain("exited with code 7");
    await transport.close();
  });

  it("drains stderr and rejects colliding server requests without resolving the client request", async () => {
    let stderr = "";
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", collisionProbe],
      requestTimeoutMs: 1_000,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    await expect(transport.send({ method: "probe" })).resolves.toEqual({
      serverRequestRejected: true,
    });
    expect(stderr).toContain("diagnostic stream drained");
    await transport.close();
  });

  it("fails a request with no response inside the configured deadline", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      requestTimeoutMs: 25,
    });
    await expect(transport.send({ method: "never/responds" })).rejects.toThrow(
      "request never/responds timed out after 25 ms",
    );
    let failure: Error | undefined;
    transport.onFailure((error) => {
      failure = error;
    });
    expect(failure?.message).toContain("request never/responds timed out");
    await transport.close();
  });

  it("terminates a child after an RPC deadline even when SIGTERM is ignored", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM",()=>{}); process.stdin.resume()',
      ],
      requestTimeoutMs: 25,
      closeTimeoutMs: 25,
    });
    await expect(transport.send({ method: "wedged" })).rejects.toThrow(
      "request wedged timed out",
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    await transport.close();
  });

  it("force-stops an app-server child that ignores cooperative shutdown", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [
        "-e",
        'const r=require("node:readline").createInterface({input:process.stdin}); process.on("SIGTERM",()=>{}); r.on("line",line=>{const m=JSON.parse(line); process.stdout.write(JSON.stringify({id:m.id,result:{ready:true}})+"\\n")})',
      ],
      closeTimeoutMs: 25,
    });
    await expect(transport.send({ method: "ready" })).resolves.toEqual({
      ready: true,
    });
    await transport.close();
    await expect(transport.send({ method: "after/close" })).rejects.toThrow(
      "transport is closed",
    );
  });

  it("rejects invalid deadlines before launching app-server", () => {
    expect(
      () =>
        new StdioJsonRpcTransport({
          command: process.execPath,
          requestTimeoutMs: 0,
        }),
    ).toThrow("request timeout must be a positive integer");
  });
});
