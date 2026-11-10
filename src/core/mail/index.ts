export { createMailer, FileMailer, getMailer, NullMailer, setMailer, SmtpMailer } from "./mailer.js";
export type { Mailer, MailMessage } from "./mailer.js";
export { resetLinkOf, sendResetEmail } from "./resetEmail.js";
export type { ResetEmail } from "./resetEmail.js";
export { renderResetPasswordEmail } from "./templates/resetPassword.js";
export type { RenderedEmail, ResetEmailInput, ResetEmailReason } from "./templates/resetPassword.js";
export { DIGEST_MAX_ITEMS, renderSmallWorksDigest } from "./templates/smallWorksDigest.js";
export type { DigestInput, DigestItem } from "./templates/smallWorksDigest.js";
