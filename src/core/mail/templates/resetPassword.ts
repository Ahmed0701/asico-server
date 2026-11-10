import type { LocaleCode } from "../../../shared/constants/enums.js";
import { fill } from "../../i18n/fill.js";
import { t, type MessageKey } from "../../i18n/index.js";

// The password reset email, as HTML and as plain text, in English or Arabic.
//
// The HTML is for mail clients, not browsers: nested tables, inline CSS only (clients drop <style> blocks, external
// sheets and most modern CSS), no images and no remote fonts. The one <style> block only adds a phone-width rule;
// the layout already works without it (fixed 600px at most, fluid below). Everything that reaches the markup from
// outside (the name, the link) goes through escapeHtml; the wording comes from the translation files.

export type ResetEmailReason = "requested" | "admin";

export type ResetEmailInput = {
  locale: LocaleCode;
  // The full reset URL, token included. Only http and https are accepted.
  link: string;
  minutes: number;
  name?: string | null | undefined;
  // "requested": the person asked for it. "admin": an administrator started it.
  reason?: ResetEmailReason;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const COLORS = {
  page: "#F3F4F6",
  card: "#FFFFFF",
  bar: "#1F3A5F",
  button: "#2F6FDE",
  ink: "#111827",
  body: "#374151",
  muted: "#6B7280",
  rule: "#E5E7EB",
  linkBox: "#F9FAFB",
} as const;

const FONT_LTR = "'Segoe UI', Helvetica, Arial, sans-serif";
// Arabic-capable faces that every desktop and phone mail client has.
const FONT_RTL = "Tahoma, Arial, sans-serif";

const NAME_MAX_LENGTH = 100;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// A name is shown on one line: control characters (line breaks included) are dropped and the length is capped.
function cleanName(name: string | null | undefined): string {
  return Array.from(name ?? "")
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20 && char.codePointAt(0) !== 0x7f)
    .join("")
    .trim()
    .slice(0, NAME_MAX_LENGTH);
}

// The link goes into an href and is also printed, so it must be a plain web URL.
function webLink(link: string): string {
  const url = new URL(link);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the reset link must be an http or https URL");
  }
  return url.toString();
}

type Copy = {
  subject: string;
  preheader: string;
  title: string;
  greeting: string;
  body: string;
  button: string;
  expiry: string;
  copyLink: string;
  ignore: string;
  footer: string;
  brand: string;
};

function copyFor(input: ResetEmailInput): Copy {
  const { locale, minutes } = input;
  const name = cleanName(input.name);
  const admin = input.reason === "admin";
  const say = (key: MessageKey, values: Record<string, string> = {}): string =>
    fill(t(locale, key), { minutes: String(minutes), ...values });
  return {
    subject: say("mail.resetPassword.subject"),
    preheader: say("mail.resetPassword.preheader"),
    title: say("mail.resetPassword.title"),
    greeting:
      name === ""
        ? say("mail.resetPassword.greetingAnonymous")
        : say("mail.resetPassword.greeting", { name }),
    body: say(admin ? "mail.resetPassword.bodyAdmin" : "mail.resetPassword.body"),
    button: say("mail.resetPassword.button"),
    expiry: say("mail.resetPassword.expiry"),
    copyLink: say("mail.resetPassword.copyLink"),
    ignore: say(admin ? "mail.resetPassword.ignoreAdmin" : "mail.resetPassword.ignore"),
    footer: say("mail.footer"),
    brand: say("mail.brand"),
  };
}

function renderText(copy: Copy, link: string): string {
  return [
    copy.title,
    "",
    copy.greeting,
    "",
    copy.body,
    "",
    link,
    "",
    copy.expiry,
    "",
    copy.ignore,
    "",
    "--",
    copy.footer,
    "",
  ].join("\n");
}

function renderHtml(copy: Copy, link: string, locale: LocaleCode): string {
  const rtl = locale === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const start = rtl ? "right" : "left";
  const font = rtl ? FONT_RTL : FONT_LTR;
  const e = escapeHtml;
  const href = e(link);
  const paragraph = (text: string, extra = ""): string =>
    `<p style="margin:0 0 16px 0;font-family:${font};font-size:15px;line-height:24px;color:${COLORS.body};text-align:${start};${extra}">${e(text)}</p>`;

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="color-scheme" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>${e(copy.subject)}</title>
<style>
@media only screen and (max-width: 620px) {
  .container { width: 100% !important; }
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
  .button-link { display: block !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.page};" dir="${dir}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${e(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.page};">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${COLORS.card};border-radius:8px;">
<tr>
<td class="pad" bgcolor="${COLORS.bar}" dir="${dir}" style="background-color:${COLORS.bar};padding:20px 32px;border-radius:8px 8px 0 0;text-align:${start};font-family:${FONT_LTR};font-size:22px;font-weight:bold;letter-spacing:0.5px;color:#FFFFFF;">${e(copy.brand)}</td>
</tr>
<tr>
<td class="pad" dir="${dir}" style="padding:32px 32px 8px 32px;text-align:${start};">
<h1 style="margin:0 0 20px 0;font-family:${font};font-size:24px;line-height:32px;font-weight:bold;color:${COLORS.ink};text-align:${start};">${e(copy.title)}</h1>
${paragraph(copy.greeting)}
${paragraph(copy.body, "margin-bottom:28px;")}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${start}" style="margin:0 0 28px 0;">
<tr>
<td align="center" bgcolor="${COLORS.button}" style="background-color:${COLORS.button};border-radius:6px;">
<a class="button-link" href="${href}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${font};font-size:16px;line-height:20px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:6px;">${e(copy.button)}</a>
</td>
</tr>
</table>
<div style="clear:both;"></div>
${paragraph(copy.expiry, `font-size:14px;color:${COLORS.muted};`)}
${paragraph(copy.copyLink, `font-size:14px;color:${COLORS.muted};margin-bottom:8px;`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
<tr>
<td dir="ltr" bgcolor="${COLORS.linkBox}" style="background-color:${COLORS.linkBox};border:1px solid ${COLORS.rule};border-radius:6px;padding:12px 14px;font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:20px;color:${COLORS.body};text-align:left;word-break:break-all;word-wrap:break-word;">${e(link)}</td>
</tr>
</table>
${paragraph(copy.ignore, `font-size:14px;color:${COLORS.muted};`)}
</td>
</tr>
<tr>
<td class="pad" dir="${dir}" style="padding:16px 32px 24px 32px;border-top:1px solid ${COLORS.rule};text-align:${start};font-family:${font};font-size:12px;line-height:18px;color:#9CA3AF;">${e(copy.footer)}</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;
}

export function renderResetPasswordEmail(input: ResetEmailInput): RenderedEmail {
  const link = webLink(input.link);
  const copy = copyFor(input);
  return { subject: copy.subject, html: renderHtml(copy, link, input.locale), text: renderText(copy, link) };
}
