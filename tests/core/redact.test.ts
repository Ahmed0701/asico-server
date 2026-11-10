import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/audit/redact.js";

describe("redact", () => {
  it("masks password, token, secret, authorization and cookie keys case-insensitively", () => {
    const result = redact({
      email: "a@x.test",
      password: "p",
      PASSWORD: "p",
      passwordHash: "h",
      newPassword: "p",
      tokenHash: "t",
      refreshToken: "t",
      client_secret: "s",
      Authorization: "Bearer x",
      cookie: "sid=1",
    });

    expect(result).toEqual({
      email: "a@x.test",
      password: "[REDACTED]",
      PASSWORD: "[REDACTED]",
      passwordHash: "[REDACTED]",
      newPassword: "[REDACTED]",
      tokenHash: "[REDACTED]",
      refreshToken: "[REDACTED]",
      client_secret: "[REDACTED]",
      Authorization: "[REDACTED]",
      cookie: "[REDACTED]",
    });
  });

  it("masks the whole value of a sensitive key, even when it holds objects", () => {
    expect(redact({ refreshTokens: [{ id: "1", tokenHash: "t" }], keep: 1 })).toEqual({
      refreshTokens: "[REDACTED]",
      keep: 1,
    });
  });

  it("masks inside nested objects and arrays", () => {
    const result = redact({ user: { name: "n", credentials: [{ password: "p", note: "keep" }] } });

    expect(result).toEqual({ user: { name: "n", credentials: [{ password: "[REDACTED]", note: "keep" }] } });
  });

  it("does not mask unrelated keys that merely look similar", () => {
    expect(redact({ author: "a", startDate: "d", status: "OPEN" })).toEqual({
      author: "a",
      startDate: "d",
      status: "OPEN",
    });
  });

  it("does not mutate its input", () => {
    const input = { password: "p", nested: { token: "t" } };

    redact(input);

    expect(input).toEqual({ password: "p", nested: { token: "t" } });
  });

  it("makes values JSON-safe", () => {
    const result = redact({
      at: new Date("2026-01-02T03:04:05.000Z"),
      big: 10n,
      nan: Number.NaN,
      skipped: undefined,
      fn: () => 1,
      list: [undefined, 1],
    });

    expect(result).toEqual({ at: "2026-01-02T03:04:05.000Z", big: "10", nan: null, list: [null, 1] });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("survives circular references and runaway depth", () => {
    const loop: Record<string, unknown> = { name: "n" };
    loop["self"] = loop;
    expect(redact(loop)).toEqual({ name: "n", self: "[CIRCULAR]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 30; i++) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redact(deep))).toContain("[TRUNCATED]");
  });

  it("returns undefined for values that have no JSON form", () => {
    expect(redact(undefined)).toBeUndefined();
    expect(redact(() => 1)).toBeUndefined();
  });
});
