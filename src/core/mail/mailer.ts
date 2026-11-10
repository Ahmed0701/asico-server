import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export type MailMessage = { to: string; subject: string; html: string; text: string };

// Anything that can deliver a message. Services depend on this, so tests hand them a fake.
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

// Never wait on a mail server for long: a dead one must not hold a request (or a shutdown) hostage.
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    settings: { host: string; port: number; secure: boolean; user: string; pass: string },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // true: TLS from the first byte (port 465). false: plain start, upgraded with STARTTLS (port 587).
      secure: settings.secure,
      requireTLS: !settings.secure,
      auth: { user: settings.user, pass: settings.pass },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

// Development without SMTP: the email is written to a file instead of being sent, and only the path is logged.
// The file holds the link, so it is the one place the link is allowed to land, and it is not a log.
export class FileMailer implements Mailer {
  constructor(private readonly directory = join(tmpdir(), "asico-mail-outbox")) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const base = join(this.directory, `email-${Date.now()}-${randomBytes(4).toString("hex")}`);
    await writeFile(`${base}.html`, message.html, { encoding: "utf8", mode: 0o600 });
    await writeFile(`${base}.txt`, `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    logger.info(
      { file: `${base}.html` },
      "SMTP is not configured: the email was written to a file, not sent",
    );
  }
}

// Tests, and any environment where nothing should leave the process.
export class NullMailer implements Mailer {
  async send(): Promise<void> {
    // intentionally empty
  }
}

export function createMailer(): Mailer {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } = env;
  if (
    SMTP_HOST !== undefined &&
    SMTP_PORT !== undefined &&
    SMTP_SECURE !== undefined &&
    SMTP_USER !== undefined &&
    SMTP_PASS !== undefined &&
    MAIL_FROM !== undefined
  ) {
    return new SmtpMailer(
      { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, user: SMTP_USER, pass: SMTP_PASS },
      MAIL_FROM,
    );
  }
  return env.NODE_ENV === "development" ? new FileMailer() : new NullMailer();
}

let current: Mailer | undefined;

// Created on first use, so importing a module that sends mail never opens anything.
export function getMailer(): Mailer {
  current ??= createMailer();
  return current;
}

// For tests: swap the mailer, or pass undefined to go back to the configured one.
export function setMailer(mailer: Mailer | undefined): void {
  current = mailer;
}
