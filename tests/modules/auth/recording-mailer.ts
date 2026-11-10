import type { Mailer, MailMessage } from "../../../src/core/mail/index.js";

// A mailer that keeps what it was asked to send, or fails on request.
export class RecordingMailer implements Mailer {
  sent: MailMessage[] = [];
  failWith: (Error & { code?: string; responseCode?: number; command?: string }) | null = null;

  async send(message: MailMessage): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.sent.push(message);
  }

  reset(): void {
    this.sent = [];
    this.failWith = null;
  }
}

// The reset link in a message: the one line of the plain-text part that is a URL.
export function linkIn(message: MailMessage): string {
  const link = message.text.split("\n").find((line) => /^https?:\/\//.test(line));
  if (!link) {
    throw new Error("the message has no link");
  }
  return link;
}

export function tokenIn(message: MailMessage): string {
  return new URL(linkIn(message)).searchParams.get("token") ?? "";
}
