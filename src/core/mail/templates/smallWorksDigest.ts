import type { LocaleCode } from "../../../shared/constants/enums.js";
import { fill } from "../../i18n/fill.js";
import { t } from "../../i18n/index.js";
import { escapeHtml, type RenderedEmail } from "./resetPassword.js";

// The digest of small works that became due soon or overdue since the last one, as HTML and as plain text. ONE email carries
// both languages (English first, then Arabic, right to left): the people who get it are the administrators, and one message
// is easier to forward than two. Like the reset email, the HTML is for mail clients: nested tables and inline CSS only, no
// images. Everything that reaches the markup from outside (villa numbers, descriptions, contractor names) goes through
// escapeHtml; the wording comes from the translation files.

export type DigestItem = {
  villaNumber: string;
  description: string;
  contractorName: string;
  endDate: string;
};
export type DigestInput = { dueSoon: readonly DigestItem[]; overdue: readonly DigestItem[] };

// Each section of each language lists at most this many works, then says how many more there are.
export const DIGEST_MAX_ITEMS = 100;
const DESCRIPTION_MAX_LENGTH = 200;

const COLORS = {
  page: "#F3F4F6",
  card: "#FFFFFF",
  bar: "#1F3A5F",
  ink: "#111827",
  body: "#374151",
  muted: "#6B7280",
  rule: "#E5E7EB",
  due: "#B45309",
  late: "#B91C1C",
} as const;

const LOCALES: readonly LocaleCode[] = ["en", "ar"];

// One line: control characters (line breaks included) become spaces, and the length is capped.
function oneLine(text: string, max: number): string {
  const flat = Array.from(text)
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 || char.codePointAt(0) === 0x7f ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type Copy = {
  locale: LocaleCode;
  heading: string;
  intro: string;
  dueSoon: string;
  overdue: string;
  columns: [string, string, string, string];
  footer: string;
  more: (count: number) => string;
};

function copyOf(locale: LocaleCode): Copy {
  const say = (key: Parameters<typeof t>[1]): string => t(locale, key);
  return {
    locale,
    heading: say("mail.smallWorksDigest.heading"),
    intro: say("mail.smallWorksDigest.intro"),
    dueSoon: say("mail.smallWorksDigest.dueSoon"),
    overdue: say("mail.smallWorksDigest.overdue"),
    columns: [
      say("mail.smallWorksDigest.villa"),
      say("mail.smallWorksDigest.description"),
      say("mail.smallWorksDigest.contractor"),
      say("mail.smallWorksDigest.endDate"),
    ],
    footer: say("mail.smallWorksDigest.footer"),
    more: (count) => fill(say("mail.smallWorksDigest.more"), { count: String(count) }),
  };
}

const cells = (item: DigestItem): [string, string, string, string] => [
  oneLine(item.villaNumber, 50),
  oneLine(item.description, DESCRIPTION_MAX_LENGTH),
  oneLine(item.contractorName, 100),
  item.endDate,
];

function sectionHtml(copy: Copy, title: string, color: string, items: readonly DigestItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const align = copy.locale === "ar" ? "right" : "left";
  const th = copy.columns
    .map(
      (name) =>
        `<th align="${align}" style="padding:6px 8px;border-bottom:2px solid ${COLORS.rule};font-size:12px;color:${COLORS.muted};font-weight:600;">${escapeHtml(name)}</th>`,
    )
    .join("");
  const rows = items
    .slice(0, DIGEST_MAX_ITEMS)
    .map(
      (item) =>
        `<tr>${cells(item)
          .map(
            (value) =>
              `<td align="${align}" style="padding:6px 8px;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.body};">${escapeHtml(value)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const rest =
    items.length > DIGEST_MAX_ITEMS
      ? `<p style="margin:8px 0 0;font-size:13px;color:${COLORS.muted};">${escapeHtml(copy.more(items.length - DIGEST_MAX_ITEMS))}</p>`
      : "";
  return `<h3 style="margin:20px 0 8px;font-size:16px;color:${color};">${escapeHtml(`${title} (${items.length})`)}</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th}</tr>${rows}</table>${rest}`;
}

function blockHtml(copy: Copy, input: DigestInput): string {
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const font =
    copy.locale === "ar" ? "Tahoma, Arial, sans-serif" : "'Segoe UI', Helvetica, Arial, sans-serif";
  return `<div dir="${dir}" lang="${copy.locale}" style="font-family:${font};text-align:${copy.locale === "ar" ? "right" : "left"};">
<h2 style="margin:0 0 8px;font-size:20px;color:${COLORS.ink};">${escapeHtml(copy.heading)}</h2>
<p style="margin:0;font-size:14px;color:${COLORS.body};">${escapeHtml(copy.intro)}</p>
${sectionHtml(copy, copy.overdue, COLORS.late, input.overdue)}
${sectionHtml(copy, copy.dueSoon, COLORS.due, input.dueSoon)}
<p style="margin:20px 0 0;font-size:12px;color:${COLORS.muted};">${escapeHtml(copy.footer)}</p>
</div>`;
}

function sectionText(copy: Copy, title: string, items: readonly DigestItem[]): string[] {
  if (items.length === 0) {
    return [];
  }
  const lines = items.slice(0, DIGEST_MAX_ITEMS).map((item) => `- ${cells(item).join(" | ")}`);
  if (items.length > DIGEST_MAX_ITEMS) {
    lines.push(copy.more(items.length - DIGEST_MAX_ITEMS));
  }
  return ["", `${title} (${items.length})`, `(${copy.columns.join(" | ")})`, ...lines];
}

function blockText(copy: Copy, input: DigestInput): string {
  return [
    copy.heading,
    copy.intro,
    ...sectionText(copy, copy.overdue, input.overdue),
    ...sectionText(copy, copy.dueSoon, input.dueSoon),
    "",
    copy.footer,
  ].join("\n");
}

export function renderSmallWorksDigest(input: DigestInput): RenderedEmail {
  const copies = LOCALES.map(copyOf);
  const counts = { dueSoon: String(input.dueSoon.length), overdue: String(input.overdue.length) };
  const subject = LOCALES.map((locale) => fill(t(locale, "mail.smallWorksDigest.subject"), counts)).join(
    " | ",
  );
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${COLORS.card};border-top:4px solid ${COLORS.bar};"><tr><td style="padding:24px;">
${copies.map((copy) => blockHtml(copy, input)).join(`\n<hr style="border:0;border-top:1px solid ${COLORS.rule};margin:28px 0;">\n`)}
</td></tr></table>
</td></tr></table>
</body></html>`;
  const text = copies.map((copy) => blockText(copy, input)).join("\n\n----------------\n\n");
  return { subject, html, text };
}
