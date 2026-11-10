import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { LocaleCode } from "../../shared/constants/enums.js";
import { PASSWORD_RESET_TTL_MINUTES } from "../../shared/constants/security.js";
import { getMailer, type Mailer } from "./mailer.js";
import { renderResetPasswordEmail, type ResetEmailReason } from "./templates/resetPassword.js";

export type ResetEmail = {
  to: string;
  name: string;
  locale: LocaleCode;
  // The raw token. It is put in the link and goes nowhere else: not into a log, not into an audit row.
  token: string;
  reason: ResetEmailReason;
};

export function resetLinkOf(token: string): string {
  const url = new URL(env.PASSWORD_RESET_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

// Sends the reset link. Resolves true when the mail server accepted it and false when it did not; it never throws
// and never logs the link, the address or the credentials, only what the server said about the failure.
export async function sendResetEmail(email: ResetEmail, mailer: Mailer = getMailer()): Promise<boolean> {
  try {
    const rendered = renderResetPasswordEmail({
      locale: email.locale,
      link: resetLinkOf(email.token),
      minutes: PASSWORD_RESET_TTL_MINUTES,
      name: email.name,
      reason: email.reason,
    });
    await mailer.send({ to: email.to, ...rendered });
    return true;
  } catch (err) {
    const failure = err as { code?: unknown; responseCode?: unknown; command?: unknown };
    logger.error(
      { code: failure.code, responseCode: failure.responseCode, command: failure.command },
      "the password reset email could not be sent",
    );
    return false;
  }
}
