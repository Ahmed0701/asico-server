import { createHmac } from "node:crypto";
import { env } from "../config/env.js";

// The same JSON whatever the order of an object's keys; arrays keep their order. `undefined` is dropped, as in JSON.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// What identifies "the same request": the method, the exact URL (query included), the body and, for an upload, a
// fingerprint of the file. It is an HMAC with a key derived from the server's secret, not a plain hash: a body such
// as POST /users holds a password, and a plain hash of it stored for a day could be guessed at offline.
export function requestHash(parts: {
  method: string;
  url: string;
  body: unknown;
  extra?: string | undefined;
}): string {
  const key = createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update("asico:idempotency:request-hash:v1")
    .digest();
  return createHmac("sha256", key)
    .update(canonicalJson([parts.method, parts.url, parts.body ?? null, parts.extra ?? null]))
    .digest("hex");
}
