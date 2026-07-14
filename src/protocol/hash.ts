import { createHash } from "node:crypto";

function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function serializeCanonical(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item) ?? "null").join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .flatMap(([key, nestedValue]) => {
        const serializedValue = serializeCanonical(nestedValue);
        return serializedValue === undefined
          ? []
          : [`${JSON.stringify(key)}:${serializedValue}`];
      });

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  const serialized = serializeCanonical(value);

  if (serialized === undefined) {
    throw new TypeError("Value cannot be represented as JSON");
  }

  return serialized;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
