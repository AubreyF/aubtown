import { describe, expect, it } from "vitest";
import { parseBindHost, parseServicePort } from "../src/config/network.js";

describe("service network configuration", () => {
  it("defaults to IPv4 loopback", () => {
    expect(parseBindHost(undefined)).toBe("127.0.0.1");
    expect(parseBindHost("  ")).toBe("127.0.0.1");
  });

  it("accepts only explicit loopback and wildcard IP addresses", () => {
    expect(parseBindHost("::1")).toBe("::1");
    expect(parseBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(() => parseBindHost("localhost")).toThrow(/explicit loopback or wildcard/);
    expect(() => parseBindHost("192.0.2.10")).toThrow(/explicit loopback or wildcard/);
  });

  it("validates service ports", () => {
    expect(parseServicePort(undefined, 9_080)).toBe(9_080);
    expect(parseServicePort("8090", 9_080)).toBe(8_090);
    expect(() => parseServicePort("0", 9_080)).toThrow(/integer/);
    expect(() => parseServicePort("not-a-port", 9_080)).toThrow(/integer/);
  });
});
