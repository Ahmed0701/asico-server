import { describe, expect, it } from "vitest";
import { writePdf } from "../../../src/shared/export/pdf.js";
import { col, document, inChunks, pageContent, readPdf, render } from "./helpers.js";

const columns = [
  col("number", "Villa Number", "text"),
  col("area", "Area", "text"),
  col("contractors", "Contractors", "text"),
  col("notified", "Notified", "date"),
  col("created", "Created (UTC)", "datetime"),
  col("flag", "Checklist", "boolean"),
  col("count", "Villas", "integer"),
];

function row(index: number) {
  return {
    number: `P-${String(index + 1).padStart(3, "0")}`,
    area: index % 2 === 0 ? "New Cairo" : "القاهرة الجديدة",
    contractors: "Nile Builders",
    notified: new Date("2026-01-05T00:00:00.000Z"),
    created: new Date("2026-03-04T05:06:00.000Z"),
    flag: index % 2 === 0,
    count: index,
  };
}

const many = (count: number) => Array.from({ length: count }, (_, index) => row(index));
const flat = (pages: string[][]) => pages.map((page) => page.join(" "));

describe("writePdf", () => {
  it("writes a PDF: the %PDF- header and an end-of-file marker", async () => {
    const { bytes } = await render(writePdf, document(columns, many(3)));

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("returns the number of data rows drawn", async () => {
    expect((await render(writePdf, document(columns, many(7)))).rows).toBe(7);
  });

  it("is A4 landscape", async () => {
    const { bytes } = await render(writePdf, document(columns, many(2)));

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (await loaded.getPage(1)).view;
    expect(Math.round(x1 - x0)).toBe(842);
    expect(Math.round(y1 - y0)).toBe(595);
  });

  it("shows the title, when it was generated (UTC) and the filters that were applied", async () => {
    const { bytes } = await render(
      writePdf,
      document(columns, many(2), { filters: ["Status: Open", "Area: New Cairo"] }),
    );

    const [first] = flat((await readPdf(bytes)).pages);
    expect(first).toContain("Test Report");
    expect(first).toContain("Generated: 2026-10-12 13:55 UTC");
    expect(first).toContain("Filters:");
    expect(first).toContain("Status: Open");
    expect(first).toContain("Area: New Cairo");
  });

  it("says so when no filter was applied", async () => {
    const { bytes } = await render(writePdf, document(columns, many(1)));

    expect(flat((await readPdf(bytes)).pages)[0]).toContain("None (all records)");
  });

  it("shows the column titles and the formatted values: dates, timestamps in UTC, Yes/No", async () => {
    const { bytes } = await render(writePdf, document(columns, many(2)));

    const text = flat((await readPdf(bytes)).pages)[0] ?? "";
    for (const title of columns.map((c) => c.title)) {
      expect(text).toContain(title);
    }
    expect(text).toContain("2026-01-05");
    expect(text).toContain("2026-03-04 05:06 UTC");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
    expect(text).toContain("P-001");
  });

  it("does not crash on an empty result: one page, the header and No records", async () => {
    const { bytes, rows } = await render(writePdf, document(columns, []));

    const { numPages, pages } = await readPdf(bytes);
    expect(rows).toBe(0);
    expect(numPages).toBe(1);
    expect(flat(pages)[0]).toContain("No records");
    expect(flat(pages)[0]).toContain("Villa Number");
    expect(flat(pages)[0]).toContain("Page 1 of 1");
  });

  it("does not show No records when there are rows", async () => {
    const { bytes } = await render(writePdf, document(columns, many(2)));

    expect(flat((await readPdf(bytes)).pages)[0]).not.toContain("No records");
  });

  describe("row striping", () => {
    // The stripe colour is #EEF2F7; every second row (the 2nd, 4th, ...) is filled with it.
    const stripes = (bytes: Buffer): number =>
      (pageContent(bytes).match(/0\.93333\d* 0\.94901\d* 0\.96862\d* scn/g) ?? []).length;

    it.each([
      [0, 0],
      [1, 0],
      [2, 1],
      [5, 2],
      [8, 4],
    ])("%i rows have %i striped rows", async (count, expected) => {
      const { bytes } = await render(writePdf, document(columns, many(count)));

      expect(stripes(bytes)).toBe(expected);
    });

    it("keeps alternating across pages", async () => {
      const { bytes } = await render(writePdf, document(columns, many(120)));

      expect(stripes(bytes)).toBe(60);
    });
  });

  describe("paging", () => {
    it("starts a new page when the rows run out of room, and every page has the header and its number", async () => {
      const { bytes } = await render(writePdf, document(columns, many(120)));

      const { numPages, pages } = await readPdf(bytes);
      expect(numPages).toBeGreaterThan(2);
      flat(pages).forEach((text, index) => {
        expect(text, `page ${index + 1}`).toContain("Villa Number");
        expect(text, `page ${index + 1}`).toContain(`Page ${index + 1} of ${numPages}`);
      });
    });

    it("draws every row exactly once, in order", async () => {
      const { bytes } = await render(writePdf, document(columns, many(120)));

      const text = flat((await readPdf(bytes)).pages).join(" ");
      const numbers = text.match(/P-\d{3}/g) ?? [];
      expect(numbers).toHaveLength(120);
      expect(numbers).toEqual(many(120).map((r) => r.number));
    });

    it("a single page is Page 1 of 1", async () => {
      const { bytes } = await render(writePdf, document(columns, many(5)));

      const { numPages, pages } = await readPdf(bytes);
      expect(numPages).toBe(1);
      expect(flat(pages)[0]).toContain("Page 1 of 1");
    });

    it("rows delivered in several chunks come out the same as in one", async () => {
      const rows = many(60);
      const chunked = await render(writePdf, { ...document(columns, []), rows: inChunks(rows, 7) });
      const whole = await render(writePdf, { ...document(columns, []), rows: inChunks(rows, 1000) });

      expect(flat((await readPdf(chunked.bytes)).pages)).toEqual(flat((await readPdf(whole.bytes)).pages));
    });
  });

  describe("Arabic", () => {
    it("draws Arabic names that are in the data, with the letters joined and readable", async () => {
      const { bytes } = await render(
        writePdf,
        document(columns, [{ ...row(0), area: "القاهرة الجديدة", contractors: "شركة النيل" }]),
      );

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).toContain("القاهرة الجديدة");
      expect(text).toContain("شركة النيل");
    });

    // Words with lam-alef are avoided in the extraction checks: the viewer reads that ligature back as two letters.
    it("draws a cell that mixes Arabic, Latin and digits", async () => {
      const { bytes } = await render(
        writePdf,
        document(columns, [{ ...row(0), contractors: "شركة النيل Nile 7 للمقاولين" }]),
      );

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).toContain("Nile 7");
      expect(text).toContain("شركة النيل");
      expect(text).toContain("للمقاولين");
    });

    it("embeds a font that has Arabic (the Arabic glyphs are in the file, not replaced by boxes)", async () => {
      const { bytes } = await render(writePdf, document(columns, [{ ...row(0), area: "القاهرة" }]));

      expect(bytes.toString("latin1")).toContain("Tajawal");
    });

    it("shows Arabic in the filter summary", async () => {
      const { bytes } = await render(writePdf, document(columns, many(1), { filters: ["Search: القاهرة"] }));

      expect(flat((await readPdf(bytes)).pages)[0]).toContain("القاهرة");
    });
  });

  describe("long text", () => {
    it("wraps text that does not fit onto more lines instead of cutting it", async () => {
      const long = "A very long contractor name that goes on and on and on ".repeat(6).trim();
      const { bytes } = await render(writePdf, document(columns, [{ ...row(0), contractors: long }]));

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).not.toContain("…");
      expect(text).toContain("A very long contractor");
      // Every word is there: none was cut away.
      expect((text.match(/\bcontractor\b/g) ?? []).length).toBe(6);
      expect((text.match(/\bon\b/g) ?? []).length).toBe(18);
    });

    it("uses an ellipsis only for a value that would take more than six lines", async () => {
      const huge = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
      const { bytes } = await render(writePdf, document(columns, [{ ...row(0), contractors: huge }]));

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).toContain("…");
      expect(text).toContain("word0");
      expect(text).not.toContain("word399");
    });

    it("keeps short text whole", async () => {
      const { bytes } = await render(writePdf, document(columns, [row(0)]));

      expect(flat((await readPdf(bytes)).pages)[0]).not.toContain("…");
    });

    it("wraps long Arabic text too, with every word", async () => {
      const long = "شركة النيل للمقاولين العامة والتوريدات ".repeat(4).trim();
      const { bytes } = await render(writePdf, document(columns, [{ ...row(0), contractors: long }]));

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).not.toContain("…");
      expect((text.match(/شركة/g) ?? []).length).toBe(4);
      expect((text.match(/النيل/g) ?? []).length).toBe(4);
    });
  });

  describe("a summary block", () => {
    it("shows the pairs above the table", async () => {
      const { bytes } = await render(
        writePdf,
        document(columns, many(2), {
          summary: [
            ["Contractor", "شركة النيل Nile"],
            ["Total villas", "12"],
            ["Open", "5"],
          ],
        }),
      );

      const text = flat((await readPdf(bytes)).pages)[0] ?? "";
      expect(text).toContain("Contractor:");
      expect(text).toContain("Total villas:");
      expect(text).toContain("12");
      expect(text).toContain("Nile");
    });
  });

  it("copes with many columns (a smaller type size) without dropping any", async () => {
    const wide = Array.from({ length: 10 }, (_, i) => col(`c${i}`, `Column ${i}`, "text"));
    const data = [Object.fromEntries(wide.map((c, i) => [c.key, `value ${i}`]))];

    const text = flat((await readPdf((await render(writePdf, document(wide, data))).bytes)).pages)[0] ?? "";

    for (let i = 0; i < 10; i++) {
      expect(text).toContain(`Column ${i}`);
      expect(text).toContain(`value ${i}`);
    }
  });

  it("is not the same file for different data (it is generated, not canned)", async () => {
    const a = await render(writePdf, document(columns, many(3)));
    const b = await render(writePdf, document(columns, many(4)));

    expect(a.bytes.equals(b.bytes)).toBe(false);
  });
});
