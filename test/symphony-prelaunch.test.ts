import { describe, expect, it } from "vitest";
import {
  denySymphonyPrelaunch,
  parseSymphonyPrelaunchRequest,
} from "../src/integrations/symphony/prelaunch.js";

const args = [
  "--schema-version",
  "1",
  "--issue-id",
  "1234",
  "--issue-identifier",
  "GH-1234",
  "--worker-host",
  "aubtown-linux",
];

describe("Symphony prelaunch protocol", () => {
  it("binds the exact GitHub issue and selected worker host", () => {
    const request = parseSymphonyPrelaunchRequest(args);
    expect(request).toEqual({
      schemaVersion: 1,
      issueId: "1234",
      issueIdentifier: "GH-1234",
      workerHost: "aubtown-linux",
    });
    expect(denySymphonyPrelaunch(request, "quota-blocked")).toEqual({
      schemaVersion: 1,
      decision: "deny",
      issueId: "1234",
      workerHost: "aubtown-linux",
      reason: "quota-blocked",
    });
  });

  it("rejects issue substitution, duplicate flags, and unbounded reasons", () => {
    expect(() =>
      parseSymphonyPrelaunchRequest(
        args.map((value) => (value === "GH-1234" ? "GH-9999" : value)),
      ),
    ).toThrow("does not match");
    expect(() =>
      parseSymphonyPrelaunchRequest([...args.slice(0, -2), "--issue-id", "1234"]),
    ).toThrow();
    expect(() =>
      denySymphonyPrelaunch(parseSymphonyPrelaunchRequest(args), "Human says maybe"),
    ).toThrow("reason is invalid");
  });
});
