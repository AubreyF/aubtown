import { isIP } from "node:net";

const ALLOWED_BIND_HOSTS = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

export function parseServicePort(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback.toLocaleString("en-US", { useGrouping: false }));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65,535.");
  }
  return parsed;
}

export function parseBindHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (isIP(host) === 0 || !ALLOWED_BIND_HOSTS.has(host)) {
    throw new Error(
      "FREEDWORKS_BIND_HOST must be an explicit loopback or wildcard IP address.",
    );
  }
  return host;
}
