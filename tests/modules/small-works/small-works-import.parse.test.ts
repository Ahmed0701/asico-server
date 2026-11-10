import { describe, expect, it } from "vitest";
import {
  parseSmallWorkRow,
  type SmallWorkLookups,
} from "../../../src/modules/small-works/service/small-works-import.service.js";
import { buildPartyIndex, buildVillaIndex, type RawCell } from "../../../src/shared/import/index.js";

// parseSmallWorkRow on its own, with the cells as the reader hands them over (a blank cell is null). The routes test it
// through files; these pin the cases a file cannot reach.
const NOW = new Date("2026-10-27T10:00:00.000Z");
// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = {
  villa: "Villa Number",
  startDate: "Start Date",
  endDate: "End Date",
  description: "Description",
  contractor: "Contractor",
  status: "Status",
};
const KEY = Object.fromEntries(Object.entries(TITLE).map(([key, title]) => [title, key]));
const titled = (cells: Record<string, RawCell>): Record<string, RawCell> =>
  Object.fromEntries(Object.entries(cells).map(([key, value]) => [TITLE[key] ?? key, value]));
const lookups: SmallWorkLookups = {
  villas: buildVillaIndex([
    { id: "v1", villaNumber: "P-001" },
    { id: "v2", villaNumber: "P-002" },
  ]),
  contractors: buildPartyIndex([
    { id: "c1", name: "Hamdy Co", phone: "0100 000 0001", status: "ACTIVE" },
    { id: "c2", name: "Mona Co", phone: "0100 000 0002", status: "ACTIVE" },
    { id: "c3", name: "Off Co", phone: "0100 000 0003", status: "INACTIVE" },
  ]),
  now: NOW,
};
const input = (cells: Record<string, RawCell> = {}): Record<string, RawCell> => ({
  villa: "P-001",
  startDate: "2026-10-01",
  endDate: "2026-10-05",
  description: "Replaced a socket",
  contractor: "Hamdy Co",
  ...cells,
});
const parse = (cells: Record<string, RawCell> = {}) => parseSmallWorkRow(titled(input(cells)), lookups);
const columns = (cells: Record<string, RawCell>): string[] =>
  parse(cells).issues.map((issue) => KEY[issue.column] ?? issue.column);
const codes = (cells: Record<string, RawCell>): string[] => parse(cells).issues.map((issue) => issue.code);

describe("parseSmallWorkRow", () => {
  it("returns the row as the insert wants it", () => {
    expect(
      parse({
        villa: " p-002 ",
        description: "  Painted ",
        contractor: " mona  CO ",
        status: "done",
      }),
    ).toEqual({
      value: {
        villaId: "v2",
        contractorId: "c2",
        startDate: new Date("2026-10-01T00:00:00.000Z"),
        endDate: new Date("2026-10-05T00:00:00.000Z"),
        description: "Painted",
        status: "DONE",
      },
      issues: [],
    });
  });

  it("makes the status PENDING for an empty cell, and takes the code or the label in any case", () => {
    expect(parse({}).value?.status).toBe("PENDING");
    expect(parse({ status: null }).value?.status).toBe("PENDING");
    for (const [status, expected] of [
      ["PENDING", "PENDING"],
      ["pending", "PENDING"],
      ["Done", "DONE"],
      ["DONE", "DONE"],
    ] as const) {
      expect(parse({ status }).value?.status, status).toBe(expected);
    }
    expect(codes({ status: "Cancelled" })).toEqual(["INVALID_OPTION"]);
  });

  it("takes a date cell and a text date alike", () => {
    expect(parse({ startDate: new Date("2026-10-02T00:00:00.000Z") }).value?.startDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
    expect(parse({ endDate: "2026-10-09" }).value?.endDate).toEqual(new Date("2026-10-09T00:00:00.000Z"));
  });

  it("requires the villa, both dates, the description and the contractor; the status is optional", () => {
    expect(
      columns({
        villa: null,
        startDate: null,
        endDate: null,
        description: null,
        contractor: null,
        status: null,
      }),
    ).toEqual(["villa", "startDate", "endDate", "description", "contractor"]);
  });

  it.each([[""], ["   "]])("refuses a villa that is %j, though the reader never hands one over", (villa) => {
    expect(columns({ villa })).toEqual(["villa"]);
  });

  it("refuses a villa that is not in the system", () => {
    expect(parse({ villa: "P-999" }).issues).toMatchObject([
      { column: TITLE.villa, code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound" },
    ]);
  });

  describe("the text limit is the API's: 500", () => {
    it("takes the longest values and refuses one character more, on the cell's own column", () => {
      expect(parse({ description: "d".repeat(500) }).issues).toEqual([]);
      expect(columns({ description: "d".repeat(501) })).toEqual(["description"]);
    });

    it("counts the characters after trimming", () => {
      expect(parse({ description: ` ${"d".repeat(500)} ` }).issues).toEqual([]);
    });

    it.each([
      ["description", { description: 12 }],
      ["contractor", { contractor: 7 }],
    ])("refuses a number in the text column %s", (column, cells) => {
      expect(codes(cells)).toEqual(["NOT_TEXT"]);
      expect(columns(cells)).toEqual([column]);
    });
  });

  it("does not read a Quantity or a Unit cell: a small work no longer has them", () => {
    expect(parse({ Quantity: 0, Unit: null } as Record<string, RawCell>)).toMatchObject({ issues: [] });
  });

  describe("the contractor", () => {
    it("is found by name (any case, extra spaces) or by phone (spaces and dashes ignored)", () => {
      expect(parse({ contractor: "HAMDY   co" }).value?.contractorId).toBe("c1");
      expect(parse({ contractor: "0100-000-0002" }).value?.contractorId).toBe("c2");
    });

    it("is refused when it is not in the system, with the not-found message on its column", () => {
      expect(parse({ contractor: "Nobody Co" }).issues).toMatchObject([
        { column: TITLE.contractor, code: "REFERENCE_NOT_FOUND", key: "import.contractorNotFound" },
      ]);
    });

    it("is refused when it is inactive, with the small works message", () => {
      expect(parse({ contractor: "Off Co" }).issues).toMatchObject([
        { column: TITLE.contractor, code: "INVALID_VALUE", key: "errors.smallWorkContractorInactive" },
      ]);
    });

    it("does not have to be the one of the villa: any active contractor does", () => {
      expect(parse({ villa: "P-001", contractor: "Mona Co" }).issues).toEqual([]);
    });

    it("is refused when two contractors answer to the text", () => {
      const twice: SmallWorkLookups = {
        ...lookups,
        contractors: buildPartyIndex([
          { id: "c1", name: "Same Co", phone: "1", status: "ACTIVE" },
          { id: "c2", name: "same co", phone: "2", status: "ACTIVE" },
        ]),
      };

      expect(
        parseSmallWorkRow(titled(input({ contractor: "Same Co" })), twice).issues.map((issue) => issue.code),
      ).toEqual(["AMBIGUOUS_REFERENCE"]);
    });
  });

  describe("the dates", () => {
    // NOW is 2026-10-27, so the bound is 2016-10-27 to 2036-10-27, both included.
    it.each([
      ["2036-10-27", true],
      ["2036-10-28", false],
      ["2027-12-01", true],
    ])("the end date %s is within the bound of 10 years: %s", (endDate, allowed) => {
      expect(parse({ startDate: "2016-10-27", endDate }).issues).toEqual(
        allowed
          ? []
          : [
              {
                column: TITLE.endDate,
                code: "INVALID_VALUE",
                key: "validation.plannedDateOutOfRange",
                value: endDate,
              },
            ],
      );
    });

    it("checks the start date against the bound on its own column, both ways", () => {
      expect(columns({ startDate: "2036-10-28", endDate: "2036-10-28" })).toEqual(["startDate", "endDate"]);
      expect(columns({ startDate: "2016-10-26", endDate: "2016-10-26" })).toEqual(["startDate", "endDate"]);
      expect(parse({ startDate: "2016-10-27", endDate: "2016-10-27" }).issues).toEqual([]);
    });

    it("takes a future date: there is no future rule", () => {
      expect(parse({ startDate: "2027-01-01", endDate: "2027-02-01" }).issues).toEqual([]);
    });

    it("accepts one day and refuses an end before the start, on the column of the end date", () => {
      expect(parse({ startDate: "2026-10-05", endDate: "2026-10-05" }).issues).toEqual([]);
      expect(parse({ startDate: "2026-10-05", endDate: "2026-10-04" }).issues).toEqual([
        {
          column: TITLE.endDate,
          code: "INVALID_VALUE",
          key: "errors.smallWorkDateRange",
          value: "2026-10-04",
        },
      ]);
    });

    it("follows the clock it is given", () => {
      const later = { ...lookups, now: new Date("2026-10-28T00:00:00.000Z") };

      expect(
        parseSmallWorkRow(titled(input({ startDate: "2036-10-28", endDate: "2036-10-28" })), later).issues,
      ).toEqual([]);
    });

    it("does not also report the bound or the order for a date it could not read", () => {
      expect(codes({ startDate: "next week" })).toEqual(["INVALID_VALUE"]);
      expect(parse({ startDate: "next week" }).issues[0]?.key).not.toBe("validation.plannedDateOutOfRange");
      expect(codes({ endDate: "soon" })).toEqual(["INVALID_VALUE"]);
      expect(parse({ endDate: "soon" }).issues[0]?.key).not.toBe("errors.smallWorkDateRange");
    });
  });

  it("gives no row when there is any issue, and no issue when there is a row", () => {
    expect(parse({ status: "Cancelled" }).value).toBeUndefined();
    expect(parse({}).issues).toEqual([]);
  });

  it("reports every bad cell of a row, in the order of the columns", () => {
    expect(
      columns({
        villa: "P-999",
        startDate: "x",
        endDate: "y",
        description: null,
        contractor: null,
        status: "?",
      }),
    ).toEqual(["startDate", "endDate", "description", "contractor", "status", "villa"]);
  });
});
