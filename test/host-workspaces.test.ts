import { describe, expect, it } from "vitest";
import { parseHostWorkspaceRoots } from "../src/config/host-workspaces.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";

const enrollments: HostEnrollments = {
  "linux-control-1": {
    enabled: true,
    lane: "linux",
    accountIds: ["codex-pro-1"],
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  },
  "macos-executor-1": {
    enabled: true,
    lane: "macos",
    accountIds: ["codex-pro-1"],
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  },
};

describe("host workspace roots", () => {
  it("binds one normalized absolute workspace root to every enabled host", () => {
    expect(
      parseHostWorkspaceRoots(
        {
          "macos-executor-1": "/Users/worker/.aubtown/workspaces",
          "linux-control-1": "/var/lib/aubtown/workspaces",
        },
        enrollments,
      ),
    ).toEqual({
      "linux-control-1": "/var/lib/aubtown/workspaces",
      "macos-executor-1": "/Users/worker/.aubtown/workspaces",
    });
  });

  it("rejects root paths and missing enabled hosts", () => {
    expect(() =>
      parseHostWorkspaceRoots(
        {
          "linux-control-1": "/",
          "macos-executor-1": "/Users/worker/.aubtown/workspaces",
        },
        enrollments,
      ),
    ).toThrow();
    expect(() =>
      parseHostWorkspaceRoots(
        { "linux-control-1": "/var/lib/aubtown/workspaces" },
        enrollments,
      ),
    ).toThrow("lacks a workspace root");
  });
});
