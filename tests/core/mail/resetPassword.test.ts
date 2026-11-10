import { describe, expect, it } from "vitest";
import { renderResetPasswordEmail, type ResetEmailInput } from "../../../src/core/mail/index.js";
import { escapeHtml } from "../../../src/core/mail/templates/resetPassword.js";
import en from "../../../src/core/i18n/locales/en.json" with { type: "json" };
import ar from "../../../src/core/i18n/locales/ar.json" with { type: "json" };

const LINK = "https://app.example.test/reset-password?token=AbC_123-xyz";
const base: ResetEmailInput = { locale: "en", link: LINK, minutes: 30, name: "Sara" };
const render = (over: Partial<ResetEmailInput> = {}) => renderResetPasswordEmail({ ...base, ...over });

// Everything inside href="..." attributes.
const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
// The text of a cell that holds only the given text (the printed link).
const hasCellWith = (html: string, text: string): boolean =>
  new RegExp(`>${escapeRegExp(text)}</td>`).test(html);
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.each(["en", "ar"] as const)("the reset password email (%s)", (locale) => {
  const dictionary = locale === "en" ? en : ar;

  it("has the link in the button and printed as text, and in the plain-text part", () => {
    const { html, text } = render({ locale });

    expect(hrefs(html)).toEqual([LINK]);
    expect(hasCellWith(html, LINK)).toBe(true);
    expect(text.split("\n")).toContain(LINK);
    // The button is the link: the anchor wraps the button label.
    expect(html).toContain(`>${dictionary["mail.resetPassword.button"]}</a>`);
  });

  it("has the title, the product name, the expiry note and the footer, with the minutes filled in", () => {
    const { html, text } = render({ locale, minutes: 45 });
    const expiry = dictionary["mail.resetPassword.expiry"].replace("{minutes}", "45");

    expect(html).toContain(dictionary["mail.resetPassword.title"]);
    expect(html).toContain(">Asico</td>");
    expect(html).toContain(expiry);
    expect(text).toContain(expiry);
    expect(html).toContain(dictionary["mail.footer"]);
    expect(text).toContain(dictionary["mail.footer"]);
    expect(html + text).not.toMatch(/\{\w+\}/);
  });

  it("says the link works for 30 minutes and once", () => {
    const { html } = render({ locale });

    expect(html).toContain("30");
    expect(html).toContain(dictionary["mail.resetPassword.expiry"].replace("{minutes}", "30"));
  });

  it("explains what to do if the button does not work, and what to do if it was not asked for", () => {
    const { html, text } = render({ locale });

    for (const key of ["mail.resetPassword.copyLink", "mail.resetPassword.ignore"] as const) {
      expect(html).toContain(escapeHtml(dictionary[key]));
    }
    expect(text).toContain(dictionary["mail.resetPassword.ignore"]);
  });

  it("uses a subject from the translation file, with no input in it", () => {
    const { subject } = render({ locale, name: "<b>x</b>" });

    expect(subject).toBe(dictionary["mail.resetPassword.subject"]);
  });

  it("greets by name, or without one", () => {
    expect(render({ locale, name: "Sara" }).html).toContain(
      escapeHtml(dictionary["mail.resetPassword.greeting"].replace("{name}", "Sara")),
    );
    for (const name of [null, undefined, "", "   "]) {
      expect(render({ locale, name }).html).toContain(dictionary["mail.resetPassword.greetingAnonymous"]);
    }
  });

  it("is a self-contained, table-based email: inline CSS, 600px, no external resources", () => {
    const { html } = render({ locale });

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/<iframe|<form|<object|<embed/i);
    // The only URL in an attribute is the reset link.
    expect(hrefs(html)).toHaveLength(1);
    expect(html.match(/(?:src)=/gi)).toBeNull();
    // One <style> block, with only the phone-width rule.
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    expect(html).toMatch(/@media only screen and \(max-width: 620px\)/);
  });

  it("has a bulletproof button: a table cell with a background, rounded corners and bold white text", () => {
    const { html } = render({ locale });
    const cell =
      /<td align="center" bgcolor="(#[0-9A-F]{6})" style="([^"]*)">\s*<a [^>]*href="[^"]*"[^>]*style="([^"]*)"/.exec(
        html,
      );

    expect(cell).not.toBeNull();
    expect(cell?.[2]).toContain(`background-color:${cell?.[1]}`);
    expect(cell?.[2]).toContain("border-radius:6px");
    expect(cell?.[3]).toContain("color:#FFFFFF");
    expect(cell?.[3]).toContain("font-weight:bold");
    expect(cell?.[3]).toContain("padding:14px 32px");
    expect(cell?.[3]).toContain("text-decoration:none");
  });

  it("has the same words in the plain-text part as in the HTML", () => {
    const { text } = render({ locale });

    for (const key of [
      "mail.resetPassword.title",
      "mail.resetPassword.body",
      "mail.resetPassword.ignore",
      "mail.footer",
    ] as const) {
      expect(text).toContain(dictionary[key]);
    }
    expect(text).not.toMatch(/<[a-z/]/i);
  });

  it("uses a hidden preheader with the minutes filled in", () => {
    const { html } = render({ locale, minutes: 30 });

    expect(html).toContain(dictionary["mail.resetPassword.preheader"].replace("{minutes}", "30"));
    expect(html).toMatch(/display:none;max-height:0;overflow:hidden/);
  });

  describe("input is never put into the markup unescaped", () => {
    const hostileNames = [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "Sara</td><td>injected",
      "O'Brien & <Sons>",
      "x\u0000y\r\nBcc: attacker@example.test",
    ];

    it.each(hostileNames)("a name of %j", (name) => {
      const { html, text } = render({ locale, name });

      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("</td><td>injected");
      expect(html).not.toMatch(/<[^>]*onerror=/i);
      const withoutControls = Array.from(name)
        .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20 && char.codePointAt(0) !== 0x7f)
        .join("");
      expect(html).toContain(escapeHtml(withoutControls));
      // The plain-text part has no line breaks from the name: it stays on one line.
      expect(text.split("\n").filter((line) => line.startsWith("Bcc:"))).toHaveLength(0);
    });

    it("a link with markup characters is escaped in the attribute and in the text", () => {
      const link = "https://app.example.test/reset?token=a&b=<c>&d=\"e'";

      const { html } = render({ locale, link });

      const escaped = escapeHtml(new URL(link).toString());
      expect(hrefs(html)).toEqual([escaped]);
      expect(hasCellWith(html, escaped)).toBe(true);
      expect(html).not.toContain("<c>");
      expect(html).not.toContain('d="e');
    });

    it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.test/x", "not a url", ""])(
      "refuses a link that is not an http(s) URL: %j",
      (link) => {
        expect(() => render({ locale, link })).toThrow();
      },
    );

    it("escapes the five characters that matter", () => {
      expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
        "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
      );
    });
  });
});

describe("the English email", () => {
  it("is left to right, in English, with the Latin font stack", () => {
    const { html } = render();

    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).not.toContain('dir="rtl"');
    expect(html).toContain("Segoe UI");
    expect(html).toContain("text-align:left");
    expect(html).toContain('align="left"');
  });
});

describe("the Arabic email", () => {
  it("is right to left: dir, lang, an Arabic-capable font stack, text and button on the right", () => {
    const { html } = render({ locale: "ar" });

    expect(html).toContain('<html lang="ar" dir="rtl"');
    expect(html).toContain('<body style="margin:0;padding:0;background-color:#F3F4F6;" dir="rtl">');
    expect(html).toContain("Tahoma, Arial, sans-serif");
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("text-align:left;font-family:Tahoma");
    // The button table is on the right too.
    expect(html).toMatch(
      /<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"/,
    );
  });

  it("keeps the printed link left to right inside the right-to-left page", () => {
    const { html } = render({ locale: "ar" });

    expect(html).toMatch(
      /<td dir="ltr"[^>]*>https:\/\/app\.example\.test\/reset-password\?token=AbC_123-xyz<\/td>/,
    );
  });

  it("is written in Arabic", () => {
    const { html, text, subject } = render({ locale: "ar" });

    for (const part of [html, text, subject]) {
      expect(part).toMatch(/[\u0600-\u06FF]/);
    }
    expect(html).not.toContain("Reset your password");
  });
});

describe("an email an administrator started", () => {
  it.each(["en", "ar"] as const)(
    "says so, and its closing line points to the administrator (%s)",
    (locale) => {
      const dictionary = locale === "en" ? en : ar;
      const { html, text } = render({ locale, reason: "admin" });

      expect(html).toContain(dictionary["mail.resetPassword.bodyAdmin"]);
      expect(html).toContain(dictionary["mail.resetPassword.ignoreAdmin"]);
      expect(html).not.toContain(escapeHtml(dictionary["mail.resetPassword.ignore"]));
      expect(text).toContain(dictionary["mail.resetPassword.bodyAdmin"]);
      expect(hrefs(html)).toEqual([LINK]);
    },
  );

  it("is the 'requested' wording by default", () => {
    expect(render().html).toContain(en["mail.resetPassword.body"]);
    expect(render().html).not.toContain(en["mail.resetPassword.bodyAdmin"]);
  });
});

describe("the translation files", () => {
  it("have every mail key in both languages, with the same placeholders", () => {
    const keys = Object.keys(en).filter(
      (key) => key.startsWith("mail.") || key === "users.passwordResetSent",
    );
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const k = key as keyof typeof en;
      expect(ar[k], key).toBeTruthy();
      const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
      expect(placeholders(ar[k]), key).toEqual(placeholders(en[k]));
    }
  });
});
