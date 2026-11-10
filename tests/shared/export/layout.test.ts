import { describe, expect, it } from "vitest";
import {
  MAX_CELL_LINES,
  MAX_COLUMN_CHARACTERS,
  MIN_COLUMN_CHARACTERS,
  MIN_FONT_SIZE,
  columnWidth,
  displayWidth,
  planColumns,
  truncate,
  widestLine,
  wrapLines,
  type ColumnMeasure,
  type Measure,
} from "../../../src/shared/export/layout.js";

// One unit per character.
const chars: Measure = (text) => Array.from(text).length;

describe("wrapLines", () => {
  it("keeps a value that fits on one line, untouched", () => {
    expect(wrapLines("5th Settlement", 14, chars)).toEqual(["5th Settlement"]);
    expect(wrapLines("West Arab", 20, chars)).toEqual(["West Arab"]);
  });

  it("breaks at spaces and never inside a word that fits", () => {
    expect(wrapLines("5th Settlement , South", 14, chars)).toEqual(["5th Settlement", ", South"]);
    expect(wrapLines("Nile Builders and Sons", 12, chars)).toEqual(["Nile", "Builders and", "Sons"]);
  });

  it("every line fits, and no word is lost or reordered", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const lines = wrapLines(text, 17, chars);

    for (const line of lines) expect(chars(line)).toBeLessThanOrEqual(17);
    expect(lines.join(" ")).toBe(text);
  });

  it("breaks after a hyphen or a slash, so an id breaks at its groups", () => {
    expect(wrapLines("aaaaaaaa-bbbbbbbb-cccccccc", 18, chars)).toEqual(["aaaaaaaa-bbbbbbbb-", "cccccccc"]);
    expect(wrapLines("north/south/east", 12, chars)).toEqual(["north/south/", "east"]);
    expect(wrapLines("contractor.update.assignments", 18, chars)).toEqual([
      "contractor.update.",
      "assignments",
    ]);
    expect(wrapLines("2001:db8:85a3::8a2e", 10, chars)).toEqual(["2001:db8:", "85a3::8a2e"]);
  });

  it("breaks a single word wider than the column between characters", () => {
    const lines = wrapLines("abcdefghijklmnopqrstuvwxyz", 10, chars);

    expect(lines).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
  });

  it("treats runs of whitespace, tabs and line breaks as one space", () => {
    expect(wrapLines("a  \t b\r\n c", 20, chars)).toEqual(["a b c"]);
  });

  it("gives one empty line for an empty value", () => {
    expect(wrapLines("", 10, chars)).toEqual([""]);
    expect(wrapLines("   ", 10, chars)).toEqual([""]);
  });

  it("wraps Arabic at its spaces, keeping each word whole and in reading order", () => {
    const text = "شركة النيل للمقاولين العامة والتوريدات";
    const lines = wrapLines(text, 14, chars);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(text);
  });

  it("never splits a character that is made of two code units", () => {
    const lines = wrapLines("😀😀😀😀😀😀😀😀", 3, chars);

    expect(lines).toEqual(["😀😀😀", "😀😀😀", "😀😀"]);
  });

  describe("the last resort", () => {
    const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i + 1}`).join(" ");

    it(`allows ${MAX_CELL_LINES} lines without any ellipsis`, () => {
      const lines = wrapLines(words(6), 5, chars);

      expect(lines).toHaveLength(6);
      expect(lines.join("")).not.toContain("…");
    });

    it("cuts a value that needs more, with an ellipsis on the last line, and no more lines than the limit", () => {
      const lines = wrapLines(words(40), 8, chars);

      expect(lines).toHaveLength(MAX_CELL_LINES);
      expect(lines.at(-1)).toMatch(/…$/);
      expect(lines.slice(0, -1).join("")).not.toContain("…");
      for (const line of lines) expect(chars(line)).toBeLessThanOrEqual(8);
    });

    it("honours a smaller limit", () => {
      expect(wrapLines(words(10), 5, chars, 2)).toHaveLength(2);
    });
  });
});

describe("truncate", () => {
  it("leaves text that fits", () => {
    expect(truncate("short", 10, chars)).toBe("short");
  });

  it("cuts to fit with the ellipsis", () => {
    const cut = truncate("abcdefghijkl", 6, chars);

    expect(cut).toBe("abcde…");
    expect(chars(cut)).toBeLessThanOrEqual(6);
  });
});

describe("planColumns", () => {
  const PAGE = 770;
  const PAD = 4;
  const text = (headerUnit: number, widestUnit: number): ColumnMeasure => ({
    kind: "text",
    headerUnit,
    widestUnit,
  });
  const fixed = (kind: ColumnMeasure["kind"], headerUnit: number, widestUnit: number): ColumnMeasure => ({
    kind,
    headerUnit,
    widestUnit,
  });
  const total = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0);

  it("always uses exactly the page width", () => {
    const plans = [
      planColumns([text(3, 5), fixed("date", 4, 5)], PAGE, PAD),
      planColumns([text(3, 200), text(3, 200), text(3, 200), text(3, 200)], PAGE, PAD),
      planColumns(
        Array.from({ length: 30 }, () => text(5, 12)),
        PAGE,
        PAD,
      ),
    ];

    for (const plan of plans) expect(total(plan.widths)).toBeCloseTo(PAGE, 5);
  });

  it("keeps a short column as wide as its content needs, and gives the spare room to the long text", () => {
    const { widths, fontSize } = planColumns(
      [fixed("text", 3, 3), text(4, 14), fixed("date", 5, 5), text(8, 40), fixed("boolean", 5, 3)],
      PAGE,
      PAD,
    );

    expect(fontSize).toBe(8);
    expect(widths[0]).toBeCloseTo(3 * 8 + 8, 5);
    expect(widths[2]).toBeCloseTo(5 * 8 + 8, 5);
    expect(widths[4]).toBeCloseTo(5 * 8 + 8, 5);
    expect(widths[3]).toBeGreaterThan(widths[1] ?? 0);
  });

  it("gives a column what its widest value needs, plus padding, when there is room", () => {
    const { widths } = planColumns([text(4, 14), text(4, 9)], PAGE, PAD);

    // Both fit with room to spare; each is at least as wide as its content.
    expect(widths[0]).toBeGreaterThanOrEqual(14 * 8 + 8);
    expect(widths[1]).toBeGreaterThanOrEqual(9 * 8 + 8);
  });

  it("narrows the text columns first, and leaves the short ones alone", () => {
    const measures = [fixed("date", 5, 5), fixed("text", 4, 4), text(5, 60), text(5, 60), text(5, 60)];
    const { widths, fontSize } = planColumns(measures, PAGE, PAD);

    expect(fontSize).toBe(8);
    expect(widths[0]).toBeCloseTo(5 * 8 + 8, 5);
    expect(widths[1]).toBeCloseTo(4 * 8 + 8, 5);
    for (const index of [2, 3, 4]) expect(widths[index]).toBeLessThan(60 * 8 + 8);
  });

  it("makes the font smaller only when narrowing the text is not enough, and never below the minimum", () => {
    const crowded = Array.from({ length: 16 }, () => text(6, 14));
    const { fontSize, widths } = planColumns(crowded, PAGE, PAD);

    expect(fontSize).toBeLessThan(8);
    expect(fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    expect(total(widths)).toBeCloseTo(PAGE, 5);
  });

  it("stops at the minimum font size however many columns there are", () => {
    const { fontSize, widths } = planColumns(
      Array.from({ length: 60 }, () => text(8, 20)),
      PAGE,
      PAD,
    );

    expect(fontSize).toBe(MIN_FONT_SIZE);
    expect(total(widths)).toBeCloseTo(PAGE, 5);
    for (const width of widths) expect(width).toBeGreaterThan(0);
  });

  it("never lets one very long text take the whole page", () => {
    const { widths } = planColumns([text(4, 5000), text(4, 10)], PAGE, PAD);

    expect(widths[0]).toBeLessThan(PAGE * 0.8);
  });

  it("works with no columns and with columns of nothing", () => {
    expect(planColumns([], PAGE, PAD).widths).toEqual([]);
    const plan = planColumns([text(0, 0), text(0, 0)], PAGE, PAD);
    expect(total(plan.widths)).toBeCloseTo(PAGE, 5);
  });
});

describe("displayWidth", () => {
  it("counts one per letter, digit or symbol", () => {
    expect(displayWidth("5th Settlement")).toBe(14);
    expect(displayWidth("P-2026-014")).toBe(10);
    expect(displayWidth("")).toBe(0);
  });

  it("counts Arabic letters one each, and not the marks on them", () => {
    expect(displayWidth("القاهرة")).toBe(7);
    expect(displayWidth("مُحَمَّد")).toBe(4);
  });

  it("counts a wide character (Chinese, Japanese, Korean, emoji) as two", () => {
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("한국어")).toBe(6);
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("ab漢")).toBe(4);
  });

  it("counts a character made of two code units once", () => {
    expect(displayWidth("𝐀𝐁")).toBe(2);
  });

  it("counts a joiner as nothing", () => {
    expect(displayWidth("a‍b")).toBe(2);
  });
});

describe("widestLine", () => {
  it("is the width of the longest line", () => {
    expect(widestLine("ab\ncdef\ngh")).toBe(4);
    expect(widestLine("ab\r\ncdef")).toBe(4);
    expect(widestLine("")).toBe(0);
  });
});

describe("columnWidth", () => {
  it("is the longest value plus a little padding", () => {
    expect(columnWidth(4, 20)).toEqual({ width: 22, wraps: false });
  });

  it("allows for a header wider than any value", () => {
    expect(columnWidth(30, 3).width).toBeGreaterThanOrEqual(30);
  });

  it("is never narrower than the minimum", () => {
    expect(columnWidth(1, 1)).toEqual({ width: MIN_COLUMN_CHARACTERS, wraps: false });
    expect(columnWidth(0, 0).width).toBe(MIN_COLUMN_CHARACTERS);
  });

  it("is never wider than the maximum, and then the value wraps", () => {
    expect(columnWidth(5, 400)).toEqual({ width: MAX_COLUMN_CHARACTERS, wraps: true });
  });

  it("does not wrap a value that fits the maximum exactly", () => {
    const { width, wraps } = columnWidth(3, MAX_COLUMN_CHARACTERS - 2);

    expect(width).toBe(MAX_COLUMN_CHARACTERS);
    expect(wraps).toBe(false);
  });
});
