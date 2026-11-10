import { describe, expect, it } from "vitest";
import {
  parseDailyReportRow,
  type DailyReportLookups,
} from "../../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { buildPartyIndex, type RawCell } from "../../../src/shared/import/index.js";

// parseDailyReportRow on its own, with the cells as the reader hands them over (a blank cell is null). The routes test it
// through files; these pin the cases a file cannot reach.
const NOW = new Date("2026-10-27T10:00:00.000Z");
const lookups: DailyReportLookups = {
  contractors: buildPartyIndex([
    { id: "c1", name: "Nile", phone: "0100 111 2222", status: "ACTIVE" },
    { id: "c2", name: "Delta", phone: "0111 333 4444", status: "ACTIVE" },
    { id: "c3", name: "Gone", phone: "0122 555 6666", status: "INACTIVE" },
  ]),
  engineers: buildPartyIndex([
    { id: "e1", name: "Mona Hassan", phone: "0100 999 0001", status: "ACTIVE" },
    { id: "e2", name: "Retired Rami", phone: "0100 999 0002", status: "INACTIVE" },
  ]),
  now: NOW,
};
// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = {
  reportDate: "Report Date",
  contractor: "Contractor",
  engineer: "Electrical Engineer",
  weather: "Weather",
  workersCount: "Workers",
  notes: "Notes",
};
const KEY = Object.fromEntries(Object.entries(TITLE).map(([key, title]) => [title, key]));
const titled = (cells: Record<string, RawCell>): Record<string, RawCell> =>
  Object.fromEntries(Object.entries(cells).map(([key, value]) => [TITLE[key] ?? key, value]));
const input = (cells: Record<string, RawCell> = {}): Record<string, RawCell> => ({
  reportDate: "2026-10-01",
  contractor: "Nile",
  engineer: "Mona Hassan",
  weather: "Sunny",
  workersCount: 5,
  ...cells,
});
const parse = (cells: Record<string, RawCell>) => parseDailyReportRow(titled(input(cells)), lookups);
const columns = (cells: Record<string, RawCell>): string[] =>
  parse(cells).issues.map((issue) => KEY[issue.column] ?? issue.column);
const codes = (cells: Record<string, RawCell>): string[] => parse(cells).issues.map((issue) => issue.code);

describe("parseDailyReportRow", () => {
  it("returns the row as the insert wants it", () => {
    expect(
      parse({ weather: "rainy", notes: " Late ", contractor: "nile", engineer: " mona hassan " }),
    ).toEqual({
      value: {
        contractorId: "c1",
        preparedByEngineerId: "e1",
        reportDate: new Date("2026-10-01T00:00:00.000Z"),
        weather: "RAINY",
        workersCount: 5,
        notes: "Late",
      },
      issues: [],
    });
  });

  it("has no villa, no work done, no issues and no preparer text: only the six fields of a report", () => {
    expect(Object.keys(parse({}).value!).sort()).toEqual(
      ["contractorId", "notes", "preparedByEngineerId", "reportDate", "weather", "workersCount"].sort(),
    );
  });

  it("leaves the notes empty when the cell is empty", () => {
    expect(parse({}).value).toMatchObject({ notes: null });
    expect(parse({ notes: "   " }).value).toMatchObject({ notes: null });
  });

  it("takes a date cell and a text date alike", () => {
    expect(parse({ reportDate: new Date("2026-10-02T00:00:00.000Z") }).value?.reportDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
    expect(parse({ reportDate: "2026-10-02" }).value?.reportDate).toEqual(
      new Date("2026-10-02T00:00:00.000Z"),
    );
  });

  it.each([0, 100000, "0", "100000", 12])("takes %j workers", (workersCount) => {
    expect(parse({ workersCount }).issues).toEqual([]);
  });

  it.each([-1, 100001, 1.5, "x", "1e3", true])("refuses %j workers", (workersCount) => {
    expect(columns({ workersCount })).toEqual(["workersCount"]);
  });

  it("takes notes up to 5,000 characters and refuses more", () => {
    expect(parse({ notes: "n".repeat(5000) }).issues).toEqual([]);
    expect(columns({ notes: "n".repeat(5001) })).toEqual(["notes"]);
  });

  it("requires the date, the contractor, the engineer, the weather and the workers", () => {
    expect(
      columns({ reportDate: null, contractor: null, engineer: null, weather: null, workersCount: null }),
    ).toEqual(["reportDate", "contractor", "engineer", "weather", "workersCount"]);
    expect(codes({ reportDate: null, contractor: null, engineer: null })).toEqual([
      "REQUIRED",
      "REQUIRED",
      "REQUIRED",
    ]);
  });

  describe("the date", () => {
    it.each([
      ["2026-10-27", true],
      ["2026-10-28", true],
      ["2026-10-29", false],
      ["2020-01-01", true],
    ])("%s at the clock of the lookups: allowed %s", (reportDate, allowed) => {
      expect(parse({ reportDate }).issues).toEqual(
        allowed
          ? []
          : [
              {
                column: TITLE.reportDate,
                code: "INVALID_VALUE",
                key: "validation.reportDateFuture",
                value: reportDate,
              },
            ],
      );
    });

    it("follows the clock it is given", () => {
      const tomorrow = { ...lookups, now: new Date("2026-10-28T00:00:00.000Z") };

      expect(parseDailyReportRow(titled(input({ reportDate: "2026-10-29" })), tomorrow).issues).toEqual([]);
    });

    it("does not also report the future for a date it could not read", () => {
      expect(codes({ reportDate: "next week" })).toEqual(["INVALID_VALUE"]);
      expect(parse({ reportDate: "next week" }).issues[0]?.key).not.toBe("validation.reportDateFuture");
    });
  });

  describe("the contractor", () => {
    it("is found by name or by phone, whatever the case and the spacing", () => {
      expect(parse({ contractor: "Nile" }).value?.contractorId).toBe("c1");
      expect(parse({ contractor: "  DELTA " }).value?.contractorId).toBe("c2");
      expect(parse({ contractor: "0100-111-2222" }).value?.contractorId).toBe("c1");
    });

    it("is any active contractor: there is no villa to be on", () => {
      expect(codes({ contractor: "Delta" })).toEqual([]);
    });

    it("refuses an unknown one with the not-found code, and an inactive one with the reports' own key", () => {
      expect(parse({ contractor: "Nobody" }).issues).toMatchObject([
        { column: TITLE.contractor, code: "REFERENCE_NOT_FOUND", key: "import.contractorNotFound" },
      ]);
      expect(parse({ contractor: "Gone" }).issues).toMatchObject([
        { column: TITLE.contractor, code: "INVALID_VALUE", key: "errors.reportContractorInactive" },
      ]);
    });
  });

  describe("the electrical engineer", () => {
    it("is found by name or by phone", () => {
      expect(parse({ engineer: "Mona Hassan" }).value?.preparedByEngineerId).toBe("e1");
      expect(parse({ engineer: "0100 999 0001" }).value?.preparedByEngineerId).toBe("e1");
    });

    it("refuses an unknown one with the not-found code, and an inactive one with the reports' own key", () => {
      expect(parse({ engineer: "Nobody" }).issues).toMatchObject([
        { column: TITLE.engineer, code: "REFERENCE_NOT_FOUND", key: "import.electricalEngineerNotFound" },
      ]);
      expect(parse({ engineer: "Retired Rami" }).issues).toMatchObject([
        { column: TITLE.engineer, code: "INVALID_VALUE", key: "errors.reportEngineerInactive" },
      ]);
    });

    it("is not looked up among the contractors, nor the contractor among the engineers", () => {
      expect(codes({ engineer: "Nile" })).toEqual(["REFERENCE_NOT_FOUND"]);
      expect(codes({ contractor: "Mona Hassan" })).toEqual(["REFERENCE_NOT_FOUND"]);
    });
  });

  it("gives no row when there is any issue, and no issue when there is a row", () => {
    expect(parse({ weather: "Snowy" }).value).toBeUndefined();
    expect(parse({}).issues).toEqual([]);
  });

  it("reports every bad cell of a row, in the order of the columns", () => {
    expect(
      columns({
        reportDate: "x",
        contractor: "Nobody",
        engineer: "Nobody",
        weather: "Snowy",
        workersCount: -1,
        notes: "n".repeat(5001),
      }),
    ).toEqual(["reportDate", "contractor", "engineer", "weather", "workersCount", "notes"]);
  });
});
