import { describe, expect, it } from "vitest";
import { parseDailyLabourRow } from "../../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { parseOpenWorkRow } from "../../../src/modules/open-works/service/open-works-import.service.js";
import { parseSiteReportRow } from "../../../src/modules/site-reports/service/site-reports-import.service.js";
import { parseSmallWorkRow } from "../../../src/modules/small-works/service/small-works-import.service.js";
import {
  buildPartyIndex,
  buildReferenceIndex,
  buildVillaIndex,
  buildVillaLookups,
  type RawCell,
} from "../../../src/shared/import/index.js";

// The four imports that take a villa by its number read the number the same way: as it is stored first, and then ignoring
// case and spaces only when one villa fits; a number that two villas fit is an error, not a guess. A number that the
// spreadsheet saved as a number is a number. The column an export adds (the villa's location) is not read at all.
const NOW = new Date("2026-10-27T10:00:00.000Z");
const VILLAS = [
  { id: "v-p1", villaNumber: "P-001", contractorId: "c1" },
  { id: "v-2235", villaNumber: "2235", contractorId: "c1" },
  { id: "v-upper", villaNumber: "AB-1", contractorId: "c1" },
  { id: "v-lower", villaNumber: "ab-1", contractorId: "c1" },
  { id: "v-spaced", villaNumber: "P 7", contractorId: "c1" },
];
const base = buildVillaLookups(VILLAS, [
  { id: "c1", name: "Nile", phone: "0100 111 2222", status: "ACTIVE" },
]);

type Parsed = {
  value: { villaId: string } | undefined;
  issues: { column: string; code: string; key: string }[];
};
type Case = { name: string; parse: (cells: Record<string, RawCell>) => Parsed; row: Record<string, RawCell> };

const cases: Case[] = [
  {
    name: "open works",
    parse: (cells) =>
      parseOpenWorkRow(cells, {
        ...base,
        phases: buildReferenceIndex([{ id: "p1", name: "Wall Piping" }]),
        phaseStatus: new Map([["p1", "ACTIVE" as const]]),
      }) as Parsed,
    row: { "Electrical Phase": "Wall Piping" },
  },
  {
    name: "small works",
    parse: (cells) =>
      parseSmallWorkRow(cells, {
        villas: buildVillaIndex(VILLAS),
        contractors: buildPartyIndex([{ id: "c1", name: "Hamdy", phone: "0100", status: "ACTIVE" }]),
        now: NOW,
      }) as unknown as Parsed,
    row: {
      "Start Date": "2026-10-01",
      "End Date": "2026-10-03",
      Description: "Socket",
      Contractor: "Hamdy",
    },
  },
  {
    name: "site reports",
    parse: (cells) =>
      parseSiteReportRow(cells, { villas: buildVillaIndex(VILLAS), now: NOW }) as unknown as Parsed,
    row: {
      Title: "Check",
      "Visit Date": "2026-10-01",
      Inspector: "Eng. Hamdy",
      Type: "Inspection",
      Rating: 4,
      Findings: "Fine",
    },
  },
  {
    name: "daily labour",
    parse: (cells) => parseDailyLabourRow(cells, { ...base, now: NOW }) as unknown as Parsed,
    row: { "Labour Date": "2026-10-01", "Labour Count": 5, Contractor: "Nile" },
  },
];

describe.each(cases)("$name: the villa number", (c) => {
  const parse = (villa: RawCell, extra: Record<string, RawCell> = {}) =>
    c.parse({ "Villa Number": villa, ...c.row, ...extra });

  it("finds a villa written as it is stored", () => {
    expect(parse("P-001")).toMatchObject({ value: { villaId: "v-p1" }, issues: [] });
  });

  it("takes a number cell: a villa number of digits that the spreadsheet kept as a number", () => {
    expect(parse(2235)).toMatchObject({ value: { villaId: "v-2235" }, issues: [] });
    expect(parse("2235")).toMatchObject({ value: { villaId: "v-2235" }, issues: [] });
  });

  it("refuses a number that is not a whole villa number, as an invalid value", () => {
    const parsed = parse(2235.5);

    expect(parsed.value).toBeUndefined();
    expect(parsed.issues.map((issue) => issue.column)).toEqual(["Villa Number"]);
  });

  it("prefers the villa that is written exactly over another that differs by case", () => {
    expect(parse("AB-1")).toMatchObject({ value: { villaId: "v-upper" } });
    expect(parse("ab-1")).toMatchObject({ value: { villaId: "v-lower" } });
  });

  it("finds a villa ignoring case and spaces when only one fits", () => {
    expect(parse(" p-001 ")).toMatchObject({ value: { villaId: "v-p1" }, issues: [] });
    expect(parse("p  7")).toMatchObject({ value: { villaId: "v-spaced" }, issues: [] });
  });

  it("says the villa is ambiguous when two fit loosely and none is written exactly", () => {
    const parsed = parse("Ab-1");

    expect(parsed.value).toBeUndefined();
    expect(parsed.issues).toEqual([
      { column: "Villa Number", code: "AMBIGUOUS_REFERENCE", key: "import.villaAmbiguous", value: "Ab-1" },
    ]);
  });

  it("says the villa is not found when none fits", () => {
    expect(parse("Z-9").issues).toEqual([
      { column: "Villa Number", code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound", value: "Z-9" },
    ]);
  });

  it("does not read the Location column the export adds, whatever it holds", () => {
    expect(parse("P-001", { Location: "Somewhere, B1, 7" })).toEqual(parse("P-001"));
    expect(parse("P-001", { Location: -1 })).toEqual(parse("P-001"));
  });
});
