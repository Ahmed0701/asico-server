import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "../../src/core/config/logger.js";

// The logger's own options, writing to a buffer instead of stdout.
function capture(): { log: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    log: pino({ ...loggerOptions, level: "trace" }, sink),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("what the logger masks", () => {
  it.each([
    ["SMTP_PASS", { SMTP_PASS: "app-password-123" }],
    ["config.SMTP_PASS", { config: { SMTP_PASS: "app-password-123" } }],
    ["a transport's auth.pass", { transport: { auth: { user: "a@b.test", pass: "app-password-123" } } }],
    ["a pass field", { smtp: { pass: "app-password-123" } }],
    ["resetLink", { resetLink: "https://x.test/?token=app-password-123" }],
    ["a nested resetLink", { mail: { resetLink: "https://x.test/?token=app-password-123" } }],
    ["link", { link: "https://x.test/?token=app-password-123" }],
    ["a nested link", { email: { link: "https://x.test/?token=app-password-123" } }],
    ["html", { html: "<a href='https://x.test/?token=app-password-123'>" }],
    ["a nested html", { message: { html: "<a href='https://x.test/?token=app-password-123'>" } }],
    ["password", { password: "app-password-123" }],
    ["a nested token", { body: { token: "app-password-123" } }],
  ])("masks %s", (_label, fields) => {
    const { log, lines } = capture();

    log.info(fields, "something happened");

    expect(JSON.stringify(lines())).not.toContain("app-password-123");
    expect(JSON.stringify(lines())).toContain("[REDACTED]");
  });

  it("leaves ordinary fields alone", () => {
    const { log, lines } = capture();

    log.info({ code: "EAUTH", responseCode: 535, file: "/tmp/x.html" }, "mail");

    expect(lines()[0]).toMatchObject({ code: "EAUTH", responseCode: 535, file: "/tmp/x.html" });
  });
});
