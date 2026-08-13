function canonicalValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Signed JSON numbers must be finite.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (entry === undefined) {
          throw new TypeError("Signed JSON cannot contain undefined values.");
        }
        return `${JSON.stringify(key)}:${canonicalValue(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Signed JSON cannot contain ${typeof value} values.`);
}

export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalValue(value));
}
