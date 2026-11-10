import { describe, expect, it } from "vitest";
import {
  parseSiteReportRow,
  type SiteReportLookups,
} from "../../../src/modules/site-reports/service/site-reports-import.service.js";
import { buildVillaIndex, type RawCell } from "../../../src/shared/import/index.js";

// parseSiteReportRow on its own, with the cells as the reader hands them over (a blank cell is null). The routes test it
// through files; these pin the cases a file cannot reach.
const NOW = new Date("2026-10-27T10:00:00.000Z");
// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = {
  villa: "Villa Number",
  title: "Title",
  visitDate: "Visit Date",
  inspector: "Inspector",
  type: "Type",
  rating: "Rating",
  findings: "Findings",
  recommendations: "Recommendations",
};
const KEY = Object.fromEntries(Object.entries(TITLE).map(([key, title]) => [title, key]));
const titled = (cells: Record<string, RawCell>): Record<string, RawCell> =>
  Object.fromEntries(Object.entries(cells).map(([key, value]) => [TITLE[key] ?? key, value]));
const lookups: SiteReportLookups = {
  villas: buildVillaIndex([
    { id: "v1", villaNumber: "P-001" },
    { id: "v2", villaNumber: "P-002" },
  ]),
  now: NOW,
};
const input = (cells: Record<string, RawCell> = {}): Record<string, RawCell> => ({
  villa: "P-001",
  title: "First fix check",
  visitDate: "2026-10-01",
  inspector: "Eng. Hamdy",
  type: "Inspection",
  rating: 4,
  findings: "All good",
  ...cells,
});
const parse = (cells: Record<string, RawCell> = {}) => parseSiteReportRow(titled(input(cells)), lookups);
const columns = (cells: Record<string, RawCell>): string[] =>
  parse(cells).issues.map((issue) => KEY[issue.column] ?? issue.column);
const codes = (cells: Record<string, RawCell>): string[] => parse(cells).issues.map((issue) => issue.code);

describe("parseSiteReportRow", () => {
  it("returns the row as the insert wants it", () => {
    expect(
      parse({
        villa: " p-002 ",
        title: "  Safety round ",
        inspector: " Mona ",
        type: "safety",
        rating: 2,
        findings: " Loose scaffold ",
        recommendations: " Tie it ",
      }),
    ).toEqual({
      value: {
        villaId: "v2",
        title: "Safety round",
        visitDate: new Date("2026-10-01T00:00:00.000Z"),
        inspector: "Mona",
        type: "SAFETY",
        rating: 2,
        findings: "Loose scaffold",
        recommendations: "Tie it",
      },
      issues: [],
    });
  });

  it("makes the recommendations null for an empty cell", () => {
    expect(parse({}).value?.recommendations).toBeNull();
    expect(parse({ recommendations: null }).value?.recommendations).toBeNull();
  });

  it("takes the type as the code or the label, in any case, and refuses anything else", () => {
    for (const [type, expected] of [
      ["INSPECTION", "INSPECTION"],
      ["inspection", "INSPECTION"],
      ["Safety", "SAFETY"],
      ["PROGRESS", "PROGRESS"],
      ["quality", "QUALITY"],
    ] as const) {
      expect(parse({ type }).value?.type, type).toBe(expected);
    }
    expect(codes({ type: "Audit" })).toEqual(["INVALID_OPTION"]);
    expect(columns({ type: "Audit" })).toEqual(["type"]);
  });

  it("takes a date cell and a text date alike", () => {
    expect(parse({ visitDate: new Date("2026-10-02T00:00:00.000Z") }).value?.visitDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
    expect(parse({ visitDate: "2026-10-02" }).value?.visitDate).toEqual(new Date("2026-10-02T00:00:00.000Z"));
  });

  it("requires the villa, the title, the date, the inspector, the type, the rating and the findings; the recommendations are optional", () => {
    expect(
      columns({
        villa: null,
        title: null,
        visitDate: null,
        inspector: null,
        type: null,
        rating: null,
        findings: null,
        recommendations: null,
      }),
    ).toEqual(["villa", "title", "visitDate", "inspector", "type", "rating", "findings"]);
  });

  it.each([[""], ["   "]])("refuses a villa that is %j, though the reader never hands one over", (villa) => {
    expect(columns({ villa })).toEqual(["villa"]);
  });

  it("refuses a villa that is not in the system", () => {
    expect(parse({ villa: "P-999" }).issues).toMatchObject([
      { column: TITLE.villa, code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound" },
    ]);
  });

  describe("the text limits are the API's: 150, 100 and 5,000", () => {
    it("takes the longest values and refuses one character more, on the cell's own column", () => {
      expect(
        parse({
          title: "t".repeat(150),
          inspector: "n".repeat(100),
          findings: "f".repeat(5000),
          recommendations: "r".repeat(5000),
        }).issues,
      ).toEqual([]);
      expect(columns({ title: "t".repeat(151) })).toEqual(["title"]);
      expect(columns({ inspector: "n".repeat(101) })).toEqual(["inspector"]);
      expect(columns({ findings: "f".repeat(5001) })).toEqual(["findings"]);
      expect(columns({ recommendations: "r".repeat(5001) })).toEqual(["recommendations"]);
    });

    it("counts the characters after trimming", () => {
      expect(parse({ title: ` ${"t".repeat(150)} `, findings: ` ${"f".repeat(5000)} ` }).issues).toEqual([]);
    });

    it("says the findings and recommendations are too long with their own messages", () => {
      expect(parse({ findings: "f".repeat(5001) }).issues[0]).toMatchObject({
        code: "INVALID_VALUE",
        key: "validation.findingsLength",
      });
      expect(parse({ recommendations: "r".repeat(5001) }).issues[0]).toMatchObject({
        code: "INVALID_VALUE",
        key: "validation.recommendationsTooLong",
      });
    });

    it.each([
      ["title", { title: 12 }],
      ["inspector", { inspector: 5 }],
      ["findings", { findings: 7 }],
      ["recommendations", { recommendations: 9 }],
    ])("refuses a number in the text column %s", (column, cells) => {
      expect(codes(cells)).toEqual(["NOT_TEXT"]);
      expect(columns(cells)).toEqual([column]);
    });
  });

  describe("the rating, as a number cell and as a text cell", () => {
    const accepted: [string, number][] = [
      ["1", 1],
      ["2", 2],
      ["3", 3],
      ["4", 4],
      ["5", 5],
      ["05", 5],
    ];
    const refused: [string, number | string | boolean][] = [
      ["zero", 0],
      ["zero as text", "0"],
      ["a negative", -1],
      ["a negative as text", "-1"],
      ["one above the top", 6],
      ["one above the top as text", "6"],
      ["a fraction", 2.5],
      ["a fraction as text", "2.5"],
      ["a whole number written with a decimal point", "3.0"],
      ["a tiny fraction above 1", 1.0000001],
      ["an exponent", "1e0"],
      ["an exponent number", 1e21],
      ["words", "good"],
      ["a sign", "+3"],
      ["a comma as the decimal mark", "2,5"],
      ["infinity as text", "Infinity"],
      ["a boolean", true],
    ];

    it.each(accepted)("takes the text %s", (text, expected) => {
      expect(parse({ rating: text }).value?.rating).toBe(expected);
    });

    it.each(accepted)("takes the number the text %s stands for", (_text, expected) => {
      expect(parse({ rating: expected }).value?.rating).toBe(expected);
    });

    it("takes a number cell that holds a whole number written with a decimal point", () => {
      expect(parse({ rating: 3.0 }).value?.rating).toBe(3);
    });

    it.each(refused)("refuses %s with INVALID_VALUE on rating and the rating message", (_name, rating) => {
      expect(parse({ rating })).toMatchObject({
        value: undefined,
        issues: [{ column: TITLE.rating, code: "INVALID_VALUE", key: "validation.ratingInvalid" }],
      });
    });

    it("trims the text of a rating", () => {
      expect(parse({ rating: " 4 " }).value?.rating).toBe(4);
    });
  });

  describe("the date", () => {
    it.each([
      ["2026-10-27", true],
      ["2026-10-28", true],
      ["2026-10-29", false],
      ["2020-01-01", true],
    ])("%s at the clock of the lookups: allowed %s", (visitDate, allowed) => {
      expect(parse({ visitDate }).issues).toEqual(
        allowed
          ? []
          : [
              {
                column: TITLE.visitDate,
                code: "INVALID_VALUE",
                key: "validation.visitDateFuture",
                value: visitDate,
              },
            ],
      );
    });

    it("follows the clock it is given", () => {
      const tomorrow = { ...lookups, now: new Date("2026-10-28T00:00:00.000Z") };

      expect(parseSiteReportRow(titled(input({ visitDate: "2026-10-29" })), tomorrow).issues).toEqual([]);
    });

    it("does not also report the future for a date it could not read", () => {
      expect(codes({ visitDate: "next week" })).toEqual(["INVALID_VALUE"]);
      expect(parse({ visitDate: "next week" }).issues[0]?.key).not.toBe("validation.visitDateFuture");
    });
  });

  it("gives no row when there is any issue, and no issue when there is a row", () => {
    expect(parse({ type: "Audit" }).value).toBeUndefined();
    expect(parse({}).issues).toEqual([]);
  });

  it("reports every bad cell of a row, in the order of the columns", () => {
    expect(
      columns({
        villa: "P-999",
        title: null,
        visitDate: "x",
        inspector: null,
        type: "?",
        rating: 0,
        findings: null,
      }),
    ).toEqual(["title", "visitDate", "inspector", "type", "rating", "findings", "villa"]);
  });
});
