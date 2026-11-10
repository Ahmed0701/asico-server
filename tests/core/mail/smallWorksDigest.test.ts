import { describe, expect, it } from "vitest";
import { DIGEST_MAX_ITEMS, renderSmallWorksDigest, type DigestItem } from "../../../src/core/mail/index.js";
import ar from "../../../src/core/i18n/locales/ar.json" with { type: "json" };
import en from "../../../src/core/i18n/locales/en.json" with { type: "json" };

const item = (extra: Partial<DigestItem> = {}): DigestItem => ({
  villaNumber: "P-001",
  description: "Seal the open sleeves",
  contractorName: "Nile Builders",
  endDate: "2026-11-05",
  ...extra,
});

describe("the small works digest email", () => {
  it("carries both languages in one message, English first and Arabic right to left", () => {
    const { html, text, subject } = renderSmallWorksDigest({ dueSoon: [item()], overdue: [item()] });

    expect(html).toContain('dir="ltr" lang="en"');
    expect(html).toContain('dir="rtl" lang="ar"');
    expect(html.indexOf('dir="ltr" lang="en"')).toBeLessThan(html.indexOf('dir="rtl" lang="ar"'));
    expect(text.indexOf(en["mail.smallWorksDigest.heading"])).toBeLessThan(
      text.indexOf(ar["mail.smallWorksDigest.heading"]),
    );
    expect(subject).toContain(" | ");
    expect(text).toContain(ar["mail.smallWorksDigest.heading"]);
  });

  it("states the counts in the subject, due soon first and overdue second, in both languages", () => {
    const { subject } = renderSmallWorksDigest({
      dueSoon: [item(), item({ villaNumber: "P-002" }), item({ villaNumber: "P-004" })],
      overdue: [item({ villaNumber: "P-003" })],
    });

    expect(subject).toBe(
      `Small works: 3 due soon, 1 overdue | ${ar["mail.smallWorksDigest.subject"].replace("{dueSoon}", "3").replace("{overdue}", "1")}`,
    );
  });

  it("lists each work with its villa, description, contractor and end date", () => {
    const { html, text } = renderSmallWorksDigest({ dueSoon: [item()], overdue: [] });

    for (const part of ["P-001", "Seal the open sleeves", "Nile Builders", "2026-11-05"]) {
      expect(html).toContain(`>${part}</td>`);
      expect(text).toContain(part);
    }
  });

  it("leaves out a section that has no work, in the HTML and in the text", () => {
    const { text, html } = renderSmallWorksDigest({ dueSoon: [item()], overdue: [] });

    expect(text).not.toContain("(0)");
    expect(html).not.toContain("(0)");
    expect(html).not.toContain(`>${en["mail.smallWorksDigest.overdue"]} (`);
  });

  it("puts the overdue works before the due soon works, in the HTML and in the text", () => {
    const { text, html } = renderSmallWorksDigest({
      dueSoon: [item({ villaNumber: "SOON" })],
      overdue: [item({ villaNumber: "LATE" })],
    });

    for (const body of [text, html]) {
      const first = body.indexOf("Overdue (1)");
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(body.indexOf("LATE"));
      expect(body.indexOf("LATE")).toBeLessThan(body.indexOf("Due soon (1)"));
      expect(body.indexOf("Due soon (1)")).toBeLessThan(body.indexOf("SOON"));
    }
  });

  it("escapes everything that comes from the data, and makes it one line", () => {
    const { html, text } = renderSmallWorksDigest({
      dueSoon: [
        item({
          villaNumber: "<b>V</b>",
          description: '<script>alert("x")</script>\nsecond line',
          contractorName: "A & B <i>",
        }),
      ],
      overdue: [],
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>V</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B &lt;i&gt;");
    expect(text).toContain("</script> second line");
  });

  it("turns control characters other than line breaks into spaces", () => {
    const { text } = renderSmallWorksDigest({
      dueSoon: [item({ description: "a\u0001b\u007fc\td" })],
      overdue: [],
    });

    expect(text).toContain("| a b c d |");
    expect([...text].some((c) => c.charCodeAt(0) === 1 || c.charCodeAt(0) === 127)).toBe(false);
  });

  it("caps a long description", () => {
    const { text } = renderSmallWorksDigest({
      dueSoon: [item({ description: "x".repeat(500) })],
      overdue: [],
    });

    expect(text).not.toContain("x".repeat(250));
    expect(text).toContain("…");
  });

  it("keeps a description of exactly 200 characters whole, and cuts one of 201 to 200", () => {
    const exact = renderSmallWorksDigest({
      dueSoon: [item({ description: "y".repeat(200) })],
      overdue: [],
    });
    const over = renderSmallWorksDigest({
      dueSoon: [item({ description: "y".repeat(201) })],
      overdue: [],
    });

    expect(exact.text).toContain(`| ${"y".repeat(200)} |`);
    expect(exact.text).not.toContain("…");
    expect(over.text).toContain(`| ${"y".repeat(199)}… |`);
  });

  it("lists exactly 100 works without a note about more, and 101 with one", () => {
    const works = (count: number) =>
      Array.from({ length: count }, (_, index) => item({ villaNumber: `V-${index}` }));
    const rows = (html: string): number => (html.match(/<tr><td align="(?:left|right)"/g) ?? []).length;
    const note = (count: number): string =>
      en["mail.smallWorksDigest.more"].replace("{count}", String(count));

    const hundred = renderSmallWorksDigest({ dueSoon: works(DIGEST_MAX_ITEMS), overdue: [] });
    const more = renderSmallWorksDigest({ dueSoon: works(DIGEST_MAX_ITEMS + 1), overdue: [] });

    expect(rows(hundred.html)).toBe(2 * DIGEST_MAX_ITEMS);
    expect(hundred.html).not.toContain("margin:8px 0 0");
    expect(hundred.text).not.toContain(note(0));
    expect(hundred.text).not.toContain("...and");
    expect(rows(more.html)).toBe(2 * DIGEST_MAX_ITEMS);
    expect(more.html).toContain(note(1));
    expect(more.text).toContain(note(1));
    expect(more.text).not.toContain(`V-${DIGEST_MAX_ITEMS} |`);
  });

  it("says in the note how many works are left out, not how many there are", () => {
    const many = Array.from({ length: DIGEST_MAX_ITEMS + 7 }, (_, index) =>
      item({ villaNumber: `V-${index}` }),
    );

    const { text, html } = renderSmallWorksDigest({ dueSoon: many, overdue: [] });

    const note = en["mail.smallWorksDigest.more"].replace("{count}", "7");
    expect(text).toContain(note);
    expect(html).toContain(note);
    expect(html).toContain(`(${DIGEST_MAX_ITEMS + 7})`);
  });

  it("lists at most 100 works per section and says how many more there are", () => {
    const many = Array.from({ length: DIGEST_MAX_ITEMS + 7 }, (_, index) =>
      item({ villaNumber: `V-${index}` }),
    );

    const { text, html } = renderSmallWorksDigest({ dueSoon: many, overdue: [] });

    expect(text).toContain(`V-${DIGEST_MAX_ITEMS - 1} |`);
    expect(text).not.toContain(`V-${DIGEST_MAX_ITEMS} |`);
    expect(text).toContain("7");
    expect(html).toContain(`(${DIGEST_MAX_ITEMS + 7})`);
  });

  it("uses no images and no external resources", () => {
    const { html } = renderSmallWorksDigest({ dueSoon: [item()], overdue: [item()] });

    expect(html).not.toMatch(/<img|src=|url\(|<link|<script/i);
  });
});
