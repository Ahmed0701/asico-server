const SENSITIVE_KEY = /password|token|secret|authorization|cookie/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function hasToJson(value: object): value is { toJSON(): unknown } {
  return "toJSON" in value && typeof value.toJSON === "function";
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): Json | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    return "[CIRCULAR]";
  }
  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }
  // Dates, Prisma Decimals and the like serialise themselves.
  if (hasToJson(value)) {
    return redactValue(value.toJSON(), depth + 1, ancestors);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, ancestors) ?? null);
    }
    const result: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) {
      const redacted = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1, ancestors);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

// Returns a JSON-safe copy with password, token, secret, authorization and cookie values masked.
export function redact(value: unknown): Json | undefined {
  return redactValue(value, 0, new WeakSet());
}
