import { describe, expect, it } from "vitest";
import { parseDailyLabourRow } from "../../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { buildVillaLookups, type RawCell } from "../../../src/shared/import/index.js";

// parseDailyLabourRow on its own, with the cells as the reader hands them over (a blank cell is null). The routes test it
// through files; these pin the cases a file cannot reach.
const NOW = new Date("2026-10-27T10:00:00.000Z");
const base = buildVillaLookups(
  [
    { id: "v1", villaNumber: "P-001", contractorId: "c1" },
    { id: "v2", villaNumber: "P-002", contractorId: null },
  ],
  [
    { id: "c1", name: "Nile", phone: "0100 111 2222", status: "ACTIVE" },
    { id: "c2", name: "Delta", phone: "0111 333 4444", status: "ACTIVE" },
    { id: "c3", name: "Gone", phone: "0122 555 6666", status: "INACTIVE" },
  ],
);
// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = {
  villa: "Villa Number",
  labourDate: "Labour Date",
  labourCount: "Labour Count",
  contractor: "Contractor",
  notes: "Notes",
};
const KEY = Object.fromEntries(Object.entries(TITLE).map(([key, title]) => [title, key]));
const titled = (cells: Record<string, RawCell>): Record<string, RawCell> =>
  Object.fromEntries(Object.entries(cells).map(([key, value]) => [TITLE[key] ?? key, value]));
const lookups = { ...base, now: NOW };
const input = (cells: Record<string, RawCell> = {}): Record<string, RawCell> => ({
  villa: "P-001",
  labourDate: "2026-10-01",
  labourCount: 5,
  contractor: "Nile",
  ...cells,
});
const parse = (cells: Record<string, RawCell>) => parseDailyLabourRow(titled(input(cells)), lookups);
const columns = (cells: Record<string, RawCell>): string[] =>
  parse(cells).issues.map((issue) => KEY[issue.column] ?? issue.column);
const codes = (cells: Record<string, RawCell>): string[] => parse(cells).issues.map((issue) => issue.code);

describe("parseDailyLabourRow", () => {
  it("returns the row as the insert wants it", () => {
    expect(parse({ notes: " Roof " })).toEqual({
      value: {
        villaId: "v1",
        labourDate: new Date("2026-10-01T00:00:00.000Z"),
        contractorId: "c1",
        labourCount: 5,
        notes: "Roof",
      },
      issues: [],
    });
  });

  it("leaves the notes empty when the cell is empty", () => {
    expect(parse({}).value).toMatchObject({ notes: null });
    expect(parse({ notes: null }).value).toMatchObject({ notes: null });
  });

  it("takes a date cell and a text date alike", () => {
    expect(parse({ labourDate: new Date("2026-10-02T00:00:00.000Z") }).value?.labourDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
    expect(parse({ labourDate: "2026-10-02" }).value?.labourDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
  });

  it.each([0, 100000, "0", "100000", 12])("takes %j workers", (labourCount) => {
    expect(parse({ labourCount }).issues).toEqual([]);
  });

  it.each([-1, 100001, 1.5, "x", "1e3", true])("refuses %j workers", (labourCount) => {
    expect(parse({ labourCount }).issues).toMatchObject([
      { column: TITLE.labourCount, code: "INVALID_VALUE", key: "validation.labourCountInvalid" },
    ]);
  });

  it("takes notes up to 500 characters and refuses more, with the API's message", () => {
    expect(parse({ notes: "n".repeat(500) }).issues).toEqual([]);
    expect(parse({ notes: "ش".repeat(500) }).issues).toEqual([]);
    expect(parse({ notes: "n".repeat(501) }).issues).toMatchObject([
      { column: TITLE.notes, code: "INVALID_VALUE", key: "validation.labourNotesTooLong" },
    ]);
  });

  it("requires the villa, the date, the count and the contractor", () => {
    expect(columns({ villa: null, labourDate: null, labourCount: null, contractor: null })).toEqual([
      "villa",
      "labourDate",
      "labourCount",
      "contractor",
    ]);
  });

  it.each([[""], ["   "]])("refuses a villa that is %j, though the reader never hands one over", (villa) => {
    expect(columns({ villa })).toEqual(["villa"]);
  });

  it.each([[""], ["   "]])("refuses a contractor that is %j", (contractor) => {
    expect(columns({ contractor })).toEqual(["contractor"]);
  });

  it("refuses a villa that is not in the system", () => {
    expect(parse({ villa: "P-999" }).issues).toMatchObject([
      { column: TITLE.villa, code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound" },
    ]);
  });

  describe("the date", () => {
    it.each([
      ["2026-10-27", true],
      ["2026-10-28", true],
      ["2026-10-29", false],
      ["2020-01-01", true],
    ])("%s at the clock of the lookups: allowed %s", (labourDate, allowed) => {
      expect(parse({ labourDate }).issues).toEqual(
        allowed
          ? []
          : [
              {
                column: TITLE.labourDate,
                code: "INVALID_VALUE",
                key: "validation.labourDateFuture",
                value: labourDate,
              },
            ],
      );
    });

    it("follows the clock it is given", () => {
      const tomorrow = { ...lookups, now: new Date("2026-10-28T00:00:00.000Z") };

      expect(parseDailyLabourRow(titled(input({ labourDate: "2026-10-29" })), tomorrow).issues).toEqual([]);
    });

    it("does not also report the future for a date it could not read", () => {
      expect(codes({ labourDate: "next week" })).toEqual(["INVALID_VALUE"]);
      expect(parse({ labourDate: "next week" }).issues[0]?.key).not.toBe("validation.labourDateFuture");
    });
  });

  describe("the contractor", () => {
    it("is the villa's own, by name or by phone, in any case", () => {
      expect(parse({ contractor: "Nile" }).value?.contractorId).toBe("c1");
      expect(parse({ contractor: "nile" }).value?.contractorId).toBe("c1");
      expect(parse({ contractor: "0100-111-2222" }).value?.contractorId).toBe("c1");
    });

    it("refuses another villa's contractor, any contractor on a villa with none, and an unknown one", () => {
      expect(parse({ contractor: "Delta" }).issues).toMatchObject([
        {
          column: TITLE.contractor,
          code: "CONTRACTOR_NOT_ON_VILLA",
          key: "errors.contractorNotOnVilla",
          value: "Delta",
        },
      ]);
      expect(codes({ villa: "P-002", contractor: "Nile" })).toEqual(["CONTRACTOR_NOT_ON_VILLA"]);
      expect(parse({ contractor: "Nobody" }).issues).toMatchObject([
        { column: TITLE.contractor, code: "REFERENCE_NOT_FOUND", key: "import.contractorNotFound" },
      ]);
    });

    it("refuses an inactive one with the daily labour's message key", () => {
      const inactive = buildVillaLookups(
        [{ id: "v1", villaNumber: "P-001", contractorId: "c3" }],
        [{ id: "c3", name: "Gone", phone: "0122 555 6666", status: "INACTIVE" }],
      );

      const { issues } = parseDailyLabourRow(titled(input({ contractor: "Gone" })), {
        ...inactive,
        now: NOW,
      });

      expect(issues).toMatchObject([
        {
          column: TITLE.contractor,
          code: "INVALID_VALUE",
          key: "errors.labourContractorInactive",
          value: "Gone",
        },
      ]);
    });

    it("is not checked when the villa is unknown: only the villa is reported", () => {
      expect(columns({ villa: "P-999", contractor: "Delta" })).toEqual(["villa"]);
    });
  });

  it("gives no row when there is any issue, and no issue when there is a row", () => {
    expect(parse({ labourCount: -1 }).value).toBeUndefined();
    expect(parse({}).issues).toEqual([]);
  });

  it("reports every bad cell of a row, in the order of the columns", () => {
    expect(columns({ villa: "P-999", labourDate: "x", labourCount: -1, contractor: null })).toEqual([
      "labourDate",
      "labourCount",
      "contractor",
      "villa",
    ]);
  });
});
