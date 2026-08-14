import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function fixture(relative: string): Promise<string> {
  return await readFile(path.join(root, relative), "utf8");
}

describe("native Linux deployment", () => {
  it("runs every production service without Docker", async () => {
    const units = await Promise.all([
      fixture("deploy/systemd/aubtown-restate.service"),
      fixture("deploy/systemd/aubtown-control-plane.service"),
      fixture("deploy/systemd/aubtown-host-edge.service"),
      fixture("deploy/systemd/aubtown-checkpoint-edge.service"),
      fixture("deploy/systemd/aubtown-register.service"),
    ]);
    expect(units.join("\n")).not.toMatch(/docker/i);
    expect(units.join("\n")).not.toContain("0.0.0.0");
    expect(units.join("\n")).toContain("AUBTOWN_BIND_HOST=127.0.0.1");
    expect(units.join("\n")).toContain("AUBTOWN_ENABLE_INTEGRATION_HARNESS=false");
  });

  it("pins Restate and keeps its interfaces on loopback", async () => {
    const unit = await fixture("deploy/systemd/aubtown-restate.service");
    const config = await fixture("deploy/restate/restate.toml");
    const installer = await fixture("scripts/install-restate-linux.sh");
    expect(unit).toContain("/opt/aubtown/restate/1.7.3/restate-server");
    expect(unit).toContain(
      "RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=",
    );
    expect(config).toContain('base-dir = "/var/lib/aubtown/restate"');
    expect(config.match(/127\.0\.0\.1/g)?.length).toBeGreaterThanOrEqual(6);
    expect(config).toContain('disable-web-ui = true');
    expect(installer).toContain('version="1.7.3"');
    expect(installer).toContain("7446cb12197a15e2c230cc9df050e40e4cc89499edaead1ff614b55cb9b4a140");
    expect(installer).toContain("ff3ed6682ab3ee2f22431f5d491c18b24fc8f0474d7e492234cfe32cbd48017d");
  });

  it("uses the Restate 1.7 request-identity setting in the optional harness", async () => {
    const compose = await fixture("deploy/compose.production.yaml");
    expect(compose).toContain(
      "RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=",
    );
    expect(compose).not.toContain("RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=");
  });

  it("uses distinct users for state and secret boundaries", async () => {
    const users = await Promise.all([
      fixture("deploy/systemd/aubtown-restate.service"),
      fixture("deploy/systemd/aubtown-control-plane.service"),
      fixture("deploy/systemd/aubtown-host-edge.service"),
      fixture("deploy/systemd/aubtown-checkpoint-edge.service"),
    ]);
    expect(users[0]).toContain("User=aubtown-restate");
    expect(users[1]).toContain("User=aubtown-control");
    expect(users[2]).toContain("User=aubtown-edge");
    expect(users[3]).toContain("User=aubtown-checkpoint");
    expect(new Set(users.map((unit) => unit.match(/^User=(.+)$/m)?.[1])).size).toBe(4);
  });

  it("keeps private keys on their required side of the checkpoint boundary", async () => {
    const control = await fixture("deploy/systemd/control-plane.env.example");
    const checkpoint = await fixture("deploy/systemd/checkpoint-edge.env.example");
    expect(control).toContain("CHECKPOINT_GRANT_PRIVATE_KEY_FILE");
    expect(control).toContain("CHECKPOINT_RECEIPT_PUBLIC_KEY_FILE");
    expect(control).not.toContain("CHECKPOINT_RECEIPT_PRIVATE_KEY_FILE");
    expect(checkpoint).toContain("CHECKPOINT_RECEIPT_PRIVATE_KEY_FILE");
    expect(checkpoint).toContain("CHECKPOINT_GRANT_PUBLIC_KEY_FILE");
    expect(checkpoint).not.toContain("CHECKPOINT_GRANT_PRIVATE_KEY_FILE");
  });
});
