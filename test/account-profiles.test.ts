import { describe, expect, it } from "vitest";
import { parseExecutionAccountProfiles } from "../src/config/account-profiles.js";
import type { HostEnrollments } from "../src/security/host-enrollment.js";

const enrollments: HostEnrollments = {
  "linux-control-1": {
    enabled: true,
    lane: "linux",
    accountIds: ["codex-pro-1"],
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----",
  },
};

describe("execution account profiles", () => {
  it("binds an account only to enrolled hosts that authorize it", () => {
    expect(
      parseExecutionAccountProfiles(
        {
          "codex-pro-1": {
            driverId: "codex-app-server-v1",
            enabled: true,
            hostIds: ["linux-control-1"],
          },
        },
        enrollments,
      ),
    ).toEqual({
      "codex-pro-1": {
        driverId: "codex-app-server-v1",
        enabled: true,
        hostIds: ["linux-control-1"],
      },
    });
  });

  it("rejects unknown hosts and account scope mismatches", () => {
    expect(() =>
      parseExecutionAccountProfiles(
        {
          "codex-pro-1": {
            driverId: "codex-app-server-v1",
            enabled: true,
            hostIds: ["unknown-host"],
          },
        },
        enrollments,
      ),
    ).toThrow("unavailable host enrollment");
    expect(() =>
      parseExecutionAccountProfiles(
        {
          "codex-pro-2": {
            driverId: "codex-app-server-v1",
            enabled: true,
            hostIds: ["linux-control-1"],
          },
        },
        enrollments,
      ),
    ).toThrow("outside host enrollment");
  });
});
