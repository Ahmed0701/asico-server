import { describe, expect, it } from "vitest";
import {
  parseVillaRow,
  villaNumberKey,
  villaPlotKey,
  VILLA_IMPORT_COLUMNS,
  type VillaImportLookups,
} from "../../../src/modules/villas/service/villas-import.service.js";
import { buildAreaIndex, buildPartyIndex, type RawCell } from "../../../src/shared/import/index.js";

const lookups: VillaImportLookups = {
  areas: buildAreaIndex([{ id: "area-1", name: "New Cairo", city: "Cairo" }]),
  civilEngineers: buildPartyIndex([
    { id: "civil-1", name: "Mona Adel", phone: "0100 111 2222", status: "ACTIVE" },
    { id: "civil-off", name: "Old Civil", phone: "0100 999 0001", status: "INACTIVE" },
  ]),
  electricalEngineers: buildPartyIndex([
    { id: "elec-1", name: "Hamdy", phone: "0111 555 6666", status: "ACTIVE" },
    { id: "elec-off", name: "Old Elec", phone: "0111 999 0002", status: "INACTIVE" },
  ]),
  contractors: buildPartyIndex([
    { id: "con-1", name: "Nile", phone: "0122 777 8888", status: "ACTIVE" },
    { id: "con-off", name: "Old Co", phone: "0122 999 0003", status: "INACTIVE" },
  ]),
};
const cells = (overrides: Record<string, RawCell> = {}): Record<string, RawCell> => ({
  "Villa Number": "V-1",
  Area: "New Cairo",
  Block: "B1",
  Plot: "1",
  "Civil Engineer": "Mona Adel",
  ...overrides,
});
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("the columns", () => {
  it("are the eleven of the sample file, in its order, then the optional Currency, and the five that are required", () => {
    expect(VILLA_IMPORT_COLUMNS.map((column) => column.header)).toEqual([
      "Villa Number",
      "Owner Name",
      "Area",
      "Block",
      "Plot",
      "Contractor",
      "Electrical Engineer",
      "Civil Engineer",
      "Start Date",
      "Target Date",
      "Budget",
      "Currency",
    ]);
    expect(VILLA_IMPORT_COLUMNS.filter((column) => column.required).map((column) => column.header)).toEqual([
      "Villa Number",
      "Area",
      "Block",
      "Plot",
      "Civil Engineer",
    ]);
  });
});

describe("parseVillaRow", () => {
  it("makes a villa of a row with only what is required: the rest is null, with no currency", () => {
    expect(parseVillaRow(cells(), lookups)).toEqual({
      value: {
        villaNumber: "V-1",
        ownerName: null,
        villaType: null,
        areaId: "area-1",
        block: "B1",
        plot: "1",
        civilEngineerId: "civil-1",
        electricalEngineerId: null,
        contractorId: null,
        startDate: null,
        targetDate: null,
        budgetMinor: null,
        currency: null,
      },
      issues: [],
    });
  });

  it("makes a villa of a full row: numbers as text, people by name or phone, days, the budget in KWD fils", () => {
    const { value, issues } = parseVillaRow(
      cells({
        "Villa Number": 2235,
        "Owner Name": " أحمد ",
        Block: 4,
        Plot: 30,
        Contractor: "0122-777-8888",
        "Electrical Engineer": "hamdy",
        "Start Date": "2026-01-15",
        "Target Date": day("2026-09-30"),
        Budget: 1250.5,
      }),
      lookups,
    );

    expect(issues).toEqual([]);
    expect(value).toEqual({
      villaNumber: "2235",
      ownerName: "أحمد",
      villaType: null,
      areaId: "area-1",
      block: "4",
      plot: "30",
      civilEngineerId: "civil-1",
      electricalEngineerId: "elec-1",
      contractorId: "con-1",
      startDate: day("2026-01-15"),
      targetDate: day("2026-09-30"),
      budgetMinor: 1_250_500,
      currency: "KWD",
    });
  });

  it("refuses a villa number of more than 50 characters, and takes an owner of up to 120", () => {
    const long = parseVillaRow(cells({ "Villa Number": "V".repeat(51) }), lookups);
    expect(long.issues).toEqual([
      { column: "Villa Number", code: "INVALID_VALUE", key: "validation.textLength", value: "V".repeat(51) },
    ]);
    expect(parseVillaRow(cells({ "Villa Number": "V".repeat(50) }), lookups).issues).toEqual([]);
    expect(parseVillaRow(cells({ "Owner Name": "O".repeat(120) }), lookups).issues).toEqual([]);
    expect(parseVillaRow(cells({ "Owner Name": "O".repeat(121) }), lookups).issues.map((i) => i.key)).toEqual(
      ["validation.ownerNameLength"],
    );
  });

  it("refuses a switched-off contractor and engineers, each with the message of its own kind", () => {
    const result = parseVillaRow(
      cells({ Contractor: "Old Co", "Electrical Engineer": "Old Elec", "Civil Engineer": "Old Civil" }),
      lookups,
    );

    expect(result.value).toBeUndefined();
    expect(result.issues.map((issue) => [issue.column, issue.code, issue.key])).toEqual([
      ["Contractor", "INVALID_VALUE", "errors.contractorInactive"],
      ["Electrical Engineer", "INVALID_VALUE", "errors.electricalEngineerInactive"],
      ["Civil Engineer", "INVALID_VALUE", "errors.civilEngineerInactive"],
    ]);
  });

  it("a budget of 0 is a budget: 0 fils in KWD", () => {
    expect(parseVillaRow(cells({ Budget: 0 }), lookups).value).toMatchObject({
      budgetMinor: 0,
      currency: "KWD",
    });
  });

  // The budget is read with the decimals of its own currency: two for EGP and USD, three for KWD, none for JPY.
  it.each([
    [1250.5, "EGP", 125_050],
    [0.29, "EGP", 29],
    [1250.5, "KWD", 1_250_500],
    [0.001, "KWD", 1],
    ["1234.567", "KWD", 1_234_567],
    [1250, "JPY", 1250],
    [75, "USD", 7500],
  ] as const)("reads the budget %j in %s as %j minor units", (budget, code, minor) => {
    const { value, issues } = parseVillaRow(cells({ Budget: budget, Currency: code }), lookups);

    expect(issues).toEqual([]);
    expect(value).toMatchObject({ budgetMinor: minor, currency: code });
  });

  it.each([
    [0.001, "EGP"],
    ["1.234", "USD"],
    [0.0001, "KWD"],
    ["1.5", "JPY"],
  ] as const)("refuses the budget %j in %s: more decimals than the currency has", (budget, code) => {
    const { value, issues } = parseVillaRow(cells({ Budget: budget, Currency: code }), lookups);

    expect(value).toBeUndefined();
    expect(issues.map((issue) => [issue.column, issue.key])).toEqual([["Budget", "import.budgetInvalid"]]);
  });

  it("reports every bad cell in the order of the columns, with the cell as it was, and no villa", () => {
    const result = parseVillaRow(
      cells({
        "Villa Number": 1.5,
        Area: "Nowhere",
        Plot: null,
        Contractor: "Nobody",
        "Civil Engineer": 12,
        Budget: "x",
      }),
      lookups,
    );

    expect(result.value).toBeUndefined();
    expect(result.issues).toEqual([
      { column: "Villa Number", code: "INVALID_VALUE", key: "import.cellNumberInvalid", value: 1.5 },
      { column: "Area", code: "REFERENCE_NOT_FOUND", key: "import.areaNotFound", value: "Nowhere" },
      { column: "Plot", code: "REQUIRED", key: "validation.required", value: null },
      {
        column: "Contractor",
        code: "REFERENCE_NOT_FOUND",
        key: "import.contractorNotFound",
        value: "Nobody",
      },
      { column: "Civil Engineer", code: "NOT_TEXT", key: "import.cellNotText", value: 12 },
      { column: "Budget", code: "INVALID_VALUE", key: "import.budgetInvalid", value: "x" },
    ]);
  });

  it("reports a missing required cell even when the cell is not in the row at all", () => {
    const result = parseVillaRow({}, lookups);

    expect(result.issues.map((issue) => [issue.column, issue.code])).toEqual([
      ["Villa Number", "REQUIRED"],
      ["Area", "REQUIRED"],
      ["Block", "REQUIRED"],
      ["Plot", "REQUIRED"],
      ["Civil Engineer", "REQUIRED"],
    ]);
  });

  it("reports a target before the start on the Target Date, and not when the day is the same or a date is missing", () => {
    const before = parseVillaRow(cells({ "Start Date": "2026-05-02", "Target Date": "2026-05-01" }), lookups);

    expect(before.value).toBeUndefined();
    expect(before.issues).toEqual([
      {
        column: "Target Date",
        code: "INVALID_VALUE",
        key: "validation.targetBeforeStart",
        value: "2026-05-01",
      },
    ]);
    for (const dates of [
      { "Start Date": "2026-05-01", "Target Date": "2026-05-01" },
      { "Target Date": "2026-05-01" },
      { "Start Date": "2026-05-01" },
    ]) {
      expect(parseVillaRow(cells(dates), lookups).issues).toEqual([]);
    }
  });

  it("does not compare the dates when one of them is bad: only the bad one is reported", () => {
    const result = parseVillaRow(cells({ "Start Date": "nope", "Target Date": "2026-05-01" }), lookups);

    expect(result.issues.map((issue) => issue.column)).toEqual(["Start Date"]);
  });
});

describe("the keys", () => {
  it("a villa number is the same ignoring case and spaces, and is not the same as another", () => {
    expect(villaNumberKey({ villaNumber: " V-001 " })).toBe(villaNumberKey({ villaNumber: "v-001" }));
    expect(villaNumberKey({ villaNumber: "V  001" })).toBe(villaNumberKey({ villaNumber: "v 001" }));
    expect(villaNumberKey({ villaNumber: "V-001" })).not.toBe(villaNumberKey({ villaNumber: "V-002" }));
  });

  it("a place is the same ignoring case and spaces in the block and plot, and differs by area, block or plot", () => {
    const place = { areaId: "a", block: "B1", plot: "30" };

    expect(villaPlotKey(place)).toBe(villaPlotKey({ areaId: "a", block: " b1", plot: "30 " }));
    expect(villaPlotKey(place)).not.toBe(villaPlotKey({ ...place, areaId: "b" }));
    expect(villaPlotKey(place)).not.toBe(villaPlotKey({ ...place, block: "B2" }));
    expect(villaPlotKey(place)).not.toBe(villaPlotKey({ ...place, plot: "31" }));
    // (block "1", plot "23") and (block "12", plot "3") are two places.
    expect(villaPlotKey({ areaId: "a", block: "1", plot: "23" })).not.toBe(
      villaPlotKey({ areaId: "a", block: "12", plot: "3" }),
    );
  });
});
