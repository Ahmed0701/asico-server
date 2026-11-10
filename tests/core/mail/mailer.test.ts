import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodemailerMock = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "id" }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock("nodemailer", () => ({ default: { createTransport: nodemailerMock.createTransport } }));

import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import {
  createMailer,
  FileMailer,
  getMailer,
  NullMailer,
  resetLinkOf,
  sendResetEmail,
  setMailer,
  SmtpMailer,
} from "../../../src/core/mail/index.js";
import { RecordingMailer } from "../../modules/auth/recording-mailer.js";

const SMTP = {
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: 465,
  SMTP_SECURE: true,
  SMTP_USER: "asico@gmail.com",
  SMTP_PASS: "abcdefghijklmnop",
  MAIL_FROM: "Asico <asico@gmail.com>",
} as const;
const UNSET = Object.fromEntries(Object.keys(SMTP).map((key) => [key, undefined]));

const original = { ...env };
function configure(values: Record<string, unknown>): void {
  Object.assign(env, values);
}

beforeEach(() => {
  nodemailerMock.sendMail.mockClear();
  nodemailerMock.createTransport.mockClear();
  configure(UNSET);
});

afterEach(() => {
  Object.assign(env, original);
  setMailer(undefined);
  vi.restoreAllMocks();
});

const message = { to: "sara@example.test", subject: "Subject", html: "<p>hi</p>", text: "hi" };

describe("SmtpMailer", () => {
  const settings = {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: "asico@gmail.com",
    pass: "secretsecretsecr",
  };

  it("connects with TLS from the first byte on port 465, with timeouts, and the account's credentials", () => {
    new SmtpMailer(settings, "Asico <asico@gmail.com>");

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: "asico@gmail.com", pass: "secretsecretsecr" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });

  it("requires STARTTLS when it is not TLS from the start (port 587)", () => {
    new SmtpMailer({ ...settings, port: 587, secure: false }, "Asico <asico@gmail.com>");

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it("sends from MAIL_FROM with the HTML and the plain-text part", async () => {
    await new SmtpMailer(settings, "Asico <asico@gmail.com>").send(message);

    expect(nodemailerMock.sendMail).toHaveBeenCalledWith({ from: "Asico <asico@gmail.com>", ...message });
  });

  it("lets the transport's failure through, for the caller to handle", async () => {
    nodemailerMock.sendMail.mockRejectedValueOnce(new Error("535"));

    await expect(new SmtpMailer(settings, "a@b.test").send(message)).rejects.toThrow("535");
  });
});

describe("createMailer", () => {
  it("is SMTP when all six settings are there", () => {
    configure({ ...SMTP, NODE_ENV: "production" });

    expect(createMailer()).toBeInstanceOf(SmtpMailer);
    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1);
  });

  it("is a file in development without SMTP", () => {
    configure({ NODE_ENV: "development" });

    expect(createMailer()).toBeInstanceOf(FileMailer);
  });

  it("is SMTP in development when SMTP is set", () => {
    configure({ ...SMTP, NODE_ENV: "development" });

    expect(createMailer()).toBeInstanceOf(SmtpMailer);
  });

  it("sends nothing in tests without SMTP", async () => {
    configure({ NODE_ENV: "test" });

    const mailer = createMailer();

    expect(mailer).toBeInstanceOf(NullMailer);
    await expect(mailer.send(message)).resolves.toBeUndefined();
  });

  it("is created on first use, once, and can be swapped for tests", () => {
    configure({ NODE_ENV: "test" });
    setMailer(undefined);
    const first = getMailer();
    expect(getMailer()).toBe(first);

    const fake = new RecordingMailer();
    setMailer(fake);
    expect(getMailer()).toBe(fake);
  });
});

describe("FileMailer", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "asico-mail-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes the HTML and a text file with the headers, and logs only the path", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const html = "<p>https://app.example.test/reset?token=SECRET-TOKEN</p>";

    await new FileMailer(directory).send({
      ...message,
      html,
      text: "link: https://x.test/?token=SECRET-TOKEN",
    });

    const files = (await readdir(directory)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^email-\d+-[0-9a-f]{8}\.html$/);
    expect(files[1]).toMatch(/\.txt$/);
    expect(await readFile(join(directory, files[0]!), "utf8")).toBe(html);
    const text = await readFile(join(directory, files[1]!), "utf8");
    expect(text).toContain("To: sara@example.test");
    expect(text).toContain("Subject: Subject");
    expect(text).toContain("SECRET-TOKEN");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({ file: join(directory, files[0]!) });
    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET-TOKEN");
  });

  it("creates the folder when it does not exist, and never overwrites an earlier email", async () => {
    const nested = join(directory, "a", "b");
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const mailer = new FileMailer(nested);

    await mailer.send(message);
    await mailer.send(message);

    expect(await readdir(nested)).toHaveLength(4);
  });
});

describe("resetLinkOf", () => {
  it("is PASSWORD_RESET_URL with the token as a query parameter", () => {
    configure({ PASSWORD_RESET_URL: "https://app.example.test/reset-password" });

    expect(resetLinkOf("AbC_123-xyz")).toBe("https://app.example.test/reset-password?token=AbC_123-xyz");
  });

  it("keeps a query string the URL already has, and encodes the token", () => {
    configure({ PASSWORD_RESET_URL: "https://app.example.test/reset?lang=ar" });

    expect(resetLinkOf("a b&c")).toBe("https://app.example.test/reset?lang=ar&token=a+b%26c");
  });
});

describe("sendResetEmail", () => {
  const email = {
    to: "sara@example.test",
    name: "Sara",
    locale: "en" as const,
    token: "TOKEN-123",
    reason: "requested" as const,
  };

  it("renders the email for the person, with the link, and resolves true", async () => {
    configure({ PASSWORD_RESET_URL: "https://app.example.test/reset-password" });
    const mailer = new RecordingMailer();

    await expect(sendResetEmail(email, mailer)).resolves.toBe(true);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "sara@example.test", subject: "Reset your Asico password" });
    expect(mailer.sent[0]?.html).toContain("https://app.example.test/reset-password?token=TOKEN-123");
    expect(mailer.sent[0]?.text).toContain("https://app.example.test/reset-password?token=TOKEN-123");
    expect(mailer.sent[0]?.text).toContain("30 minutes");
  });

  it("goes through the configured mailer when none is given", async () => {
    const mailer = new RecordingMailer();
    setMailer(mailer);

    await sendResetEmail(email);

    expect(mailer.sent).toHaveLength(1);
  });

  it("resolves false and logs only the failure's code, response code and command", async () => {
    const mailer = new RecordingMailer();
    mailer.failWith = Object.assign(new Error("Invalid login: user sara@example.test pass hunter2"), {
      code: "EAUTH",
      responseCode: 535,
      command: "AUTH PLAIN",
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(sendResetEmail(email, mailer)).resolves.toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
    const logged = JSON.stringify(error.mock.calls);
    for (const secret of ["sara@example.test", "hunter2", "TOKEN-123", "Invalid login"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("never throws, even when the email cannot be made", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    configure({ PASSWORD_RESET_URL: "ftp://files.example.test/reset" });

    await expect(sendResetEmail(email, new RecordingMailer())).resolves.toBe(false);
  });
});
