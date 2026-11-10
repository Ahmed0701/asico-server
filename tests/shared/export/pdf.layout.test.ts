import { describe, expect, it } from "vitest";
import { writePdf } from "../../../src/shared/export/pdf.js";
import { col, document, inChunks, pageContent, readPdf, readPlacedText, render } from "./helpers.js";

const flat = (pages: string[][]) => pages.map((page) => page.join(" "));

// Columns like the villas export: short ones beside text that varies a lot.
const villaColumns = [
  col("number", "Villa Number", "text"),
  col("area", "Area", "text"),
  col("block", "Block", "text"),
  col("plot", "Plot Number", "text"),
  col("status", "Status", "text"),
  col("engineer", "Civil Engineer", "text"),
  col("contractors", "Contractors", "text"),
  col("notified", "Notified", "date"),
  col("expected", "Expected Receipt Date", "date"),
  col("checklist", "Checklist Completed", "boolean"),
  col("material", "Material Requested", "boolean"),
  col("progress", "Progress", "text"),
  col("created", "Created (UTC)", "datetime"),
];

const villa = (index: number, over: Record<string, string> = {}) => ({
  number: `P-2026-${String(index + 1).padStart(4, "0")}`,
  area: "5th Settlement",
  block: "West Arab",
  plot: String(100 + index),
  status: "In Progress",
  engineer: "Mona Hassan",
  contractors: "Nile Builders, Delta Contracting",
  notified: new Date("2026-01-05T00:00:00.000Z"),
  expected: new Date("2026-09-01T00:00:00.000Z"),
  checklist: true,
  material: false,
  progress: "3/5 (60%)",
  created: new Date("2026-03-04T05:06:00.000Z"),
  ...over,
});

const fontSizes = (bytes: Buffer): number[] =>
  [...pageContent(bytes).matchAll(/\s([\d.]+) Tf/g)].map((match) => Number(match[1]));

describe("writePdf layout", () => {
  it.each(["5th Settlement", "West Arab"])("shows %j in full, with no ellipsis", async (value) => {
    const { bytes } = await render(writePdf, document(villaColumns, [villa(0), villa(1)]));

    const text = flat((await readPdf(bytes)).pages)[0] ?? "";
    expect(text).toContain(value);
    expect(text).not.toContain("…");
  });

  it("keeps the short columns narrow: a plot number takes less room than the text beside it", async () => {
    const { bytes } = await render(
      writePdf,
      document(villaColumns, [
        villa(0, { contractors: "Nile Builders, Delta Contracting, Upper Egypt Engineering Works" }),
      ]),
    );

    const items = (await readPlacedText(bytes))[0] ?? [];
    const x = (text: string) => items.find((item) => item.text === text)?.x ?? Number.NaN;
    const widthOf = (from: string, to: string) => x(to) - x(from);
    expect(widthOf("Plot", "Status")).toBeLessThan(widthOf("Civil", "Contractors"));
    expect(widthOf("Plot", "Status")).toBeLessThan(widthOf("Contractors", "Notified"));
  });

  it("wraps a long area and a long block, and every word is there", async () => {
    const { bytes } = await render(
      writePdf,
      document(villaColumns, [
        villa(0, {
          area: "5th Settlement , South of the Ring Road Extension",
          block: "West Arab Contractors Housing Compound",
        }),
      ]),
    );

    const text = flat((await readPdf(bytes)).pages)[0] ?? "";
    expect(text).not.toContain("…");
    for (const word of ["5th", "Settlement", "Ring", "Road", "Extension", "West", "Arab", "Compound"]) {
      expect(text).toContain(word);
    }
  });

  it("handles long Arabic and English names in the same table", async () => {
    const { bytes } = await render(
      writePdf,
      document(villaColumns, [
        villa(0, { area: "التجمع الخامس - الحي الأول المنطقة الشمالية", engineer: "م. محمد عبد الرحمن" }),
        villa(1, {
          contractors: "شركة النيل للمقاولين العامة، Delta Contracting Group, شركة الدلتا للإنشاءات",
        }),
      ]),
    );

    const text = flat((await readPdf(bytes)).pages)[0] ?? "";
    expect(text).not.toContain("…");
    for (const word of ["التجمع", "الخامس", "الشمالية", "محمد", "الرحمن", "شركة", "Delta", "الدلتا"]) {
      expect(text).toContain(word);
    }
  });

  it("a row grows to the height of its tallest cell: the next row starts below all its lines", async () => {
    const tokens = Array.from({ length: 30 }, (_, w) => `t${w}`).join(" ");
    const { bytes } = await render(
      writePdf,
      document(villaColumns, [villa(0, { area: tokens }), villa(1, { number: "NEXT-ROW" })]),
    );

    const items = (await readPlacedText(bytes))[0] ?? [];
    const lowestOfTall = Math.min(...items.filter((item) => /^t\d+$/.test(item.text)).map((item) => item.y));
    const next = items.find((item) => item.text === "NEXT-ROW");
    expect(next?.y).toBeLessThan(lowestOfTall);
  });

  describe("rows are never split across pages", () => {
    // Every row carries tokens r<row>w<word>; a split row would have them on two pages.
    const tokens = (row: number) => Array.from({ length: 14 }, (_, w) => `r${row}w${w}`).join(" ");
    const data = () =>
      Array.from({ length: 90 }, (_, i) =>
        villa(i, {
          contractors: i % 3 === 0 ? tokens(i) : `r${i}w0`,
          area: i % 5 === 0 ? tokens(i) : "5th Settlement",
        }),
      );

    it("keeps all the lines of a row on one page, above the footer", async () => {
      const { bytes } = await render(writePdf, document(villaColumns, data()));

      const pages = await readPlacedText(bytes);
      expect(pages.length).toBeGreaterThan(2);
      const pageOf = new Map<string, Set<number>>();
      pages.forEach((items, page) => {
        for (const item of items) {
          for (const token of item.text.match(/r\d+w\d+/g) ?? []) {
            const row = token.slice(0, token.indexOf("w"));
            pageOf.set(row, (pageOf.get(row) ?? new Set<number>()).add(page));
            // The page is 595pt high; the bottom margin and the footer take the lowest 58pt.
            expect(item.y, token).toBeGreaterThan(58);
          }
        }
      });
      expect(pageOf.size).toBe(90);
      for (const [row, set] of pageOf) expect(set.size, row).toBe(1);
    });

    it("starts every page with the header again, and keeps the rows in order", async () => {
      const { bytes } = await render(writePdf, document(villaColumns, data()));

      const { pages, numPages } = await readPdf(bytes);
      expect(numPages).toBeGreaterThan(2);
      pages.forEach((items, index) => expect(items.join(" "), `page ${index + 1}`).toContain("Villa Number"));
      const order = (
        pages
          .flat()
          .join(" ")
          .match(/r\d+w0/g) ?? []
      ).map((token) => Number(token.slice(1, -2)));
      expect([...new Set(order)]).toEqual(Array.from({ length: 90 }, (_, i) => i));
    });
  });

  it("never draws text smaller than 7pt, however many columns", async () => {
    const wide = Array.from({ length: 24 }, (_, i) => col(`c${i}`, `Column heading ${i}`, "text"));
    const data = [Object.fromEntries(wide.map((c, i) => [c.key, `a fairly long value for column ${i}`]))];
    const { bytes } = await render(writePdf, document(wide, data));

    const sizes = fontSizes(bytes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(7);
  });

  it("uses the normal size when everything fits", async () => {
    const { bytes } = await render(writePdf, document(villaColumns.slice(0, 4), [villa(0)]));

    expect(fontSizes(bytes)).toContain(8);
  });

  it("makes the type smaller (not below 7pt) before it gives up on showing a value whole", async () => {
    const { bytes } = await render(writePdf, document(villaColumns, [villa(0), villa(1)]));

    const sizes = fontSizes(bytes);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(7);
  });

  it("exports 5,000 rows in a reasonable time", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      villa(i, {
        area: i % 7 === 0 ? "5th Settlement , South of the Ring Road Extension" : "5th Settlement",
        contractors:
          i % 4 === 0 ? "شركة النيل للمقاولين، Delta Contracting Group, Upper Egypt Works" : "Nile Builders",
      }),
    );
    const started = Date.now();

    const { bytes, rows: written } = await render(writePdf, {
      ...document(villaColumns, []),
      rows: inChunks(rows, 500),
    });

    const seconds = (Date.now() - started) / 1000;
    expect(written).toBe(5000);
    expect(seconds).toBeLessThan(30);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await readPdf(bytes)).numPages).toBeGreaterThan(50);
  }, 90_000);
});
