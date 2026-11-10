import { describe, expect, it } from "vitest";
import {
  parseOpenWorkRow,
  type OpenWorkLookups,
} from "../../../src/modules/open-works/service/open-works-import.service.js";
import { buildReferenceIndex, buildVillaLookups, type RawCell } from "../../../src/shared/import/index.js";

// parseOpenWorkRow on its own, with the cells as the reader hands them over (a blank cell is null, text is trimmed of
// nothing but blanks). The routes test it through files; these pin the cases a file cannot reach.
// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = {
  villa: "Villa Number",
  phase: "Electrical Phase",
  status: "Status",
  priority: "Priority",
  progress: "Progress",
  contractor: "Contractor",
  startDate: "Start Date",
  endDate: "End Date",
  source: "Source",
};
const KEY = Object.fromEntries(Object.entries(TITLE).map(([key, title]) => [title, key]));
const titled = (cells: Record<string, RawCell>): Record<string, RawCell> =>
  Object.fromEntries(Object.entries(cells).map(([key, value]) => [TITLE[key] ?? key, value]));
const phases = [
  { id: "p1", name: "Wall Piping", status: "ACTIVE" as const },
  { id: "p2", name: "Sleeves", status: "ACTIVE" as const },
  { id: "p3", name: "Old Phase", status: "INACTIVE" as const },
];
const lookups: OpenWorkLookups = {
  ...buildVillaLookups(
    [{ id: "v1", villaNumber: "P-001", contractorId: "c1" }],
    [{ id: "c1", name: "Nile", phone: "0100 111 2222", status: "ACTIVE" }],
  ),
  phases: buildReferenceIndex(phases),
  phaseStatus: new Map(phases.map((phase) => [phase.id, phase.status] as const)),
};
const parse = (cells: Record<string, RawCell>) =>
  parseOpenWorkRow(titled({ villa: "P-001", phase: "Wall Piping", ...cells }), lookups);
const columns = (cells: Record<string, RawCell>): string[] =>
  parse(cells).issues.map((issue) => KEY[issue.column] ?? issue.column);

describe("parseOpenWorkRow", () => {
  it("returns the row as the insert wants it", () => {
    expect(parse({ phase: "  sleeves ", priority: "high", progress: 40, contractor: "nile" })).toEqual({
      value: {
        villaId: "v1",
        elecPhaseId: "p2",
        status: "IN_PROGRESS",
        priority: "HIGH",
        progress: 40,
        contractorId: "c1",
        startDate: null,
        endDate: null,
      },
      issues: [],
    });
  });

  it("has no title and no work phase: the row is the villa, the electrical phase and the rest", () => {
    const row = parse({}).value!;

    expect(Object.keys(row).sort()).toEqual(
      [
        "contractorId",
        "elecPhaseId",
        "endDate",
        "priority",
        "progress",
        "startDate",
        "status",
        "villaId",
      ].sort(),
    );
  });

  it("finds the phase by its name, whatever the case and the blanks around it", () => {
    for (const phase of ["wall piping", "WALL PIPING", "  Wall Piping  "]) {
      expect(parse({ phase }).value?.elecPhaseId, phase).toBe("p1");
    }
  });

  it("requires the electrical phase", () => {
    expect(columns({ phase: null })).toEqual(["phase"]);
    expect(parse({ phase: null }).issues).toMatchObject([{ code: "REQUIRED" }]);
  });

  it("refuses a phase that is not in the system, with the not-found code on its column", () => {
    expect(parse({ phase: "Plastering" }).issues).toMatchObject([
      { column: TITLE.phase, code: "REFERENCE_NOT_FOUND" },
    ]);
  });

  it("refuses a phase that is switched off, with the API's own message", () => {
    expect(parse({ phase: "Old Phase" })).toMatchObject({
      value: undefined,
      issues: [{ column: TITLE.phase, code: "INVALID_VALUE", key: "errors.workElecPhaseInactive" }],
    });
  });

  it("refuses a villa that is empty text", () => {
    expect(columns({ villa: "" })).toEqual(["villa"]);
  });

  it("gives no row when there is any issue, and no issue when there is a row", () => {
    expect(parse({ status: "Paused" }).value).toBeUndefined();
    expect(parse({}).issues).toEqual([]);
  });

  it("raises no disagreement of status and progress when one of them could not be read", () => {
    expect(columns({ status: "Paused", progress: 50 })).toEqual(["status"]);
    expect(columns({ status: "Done", progress: 101 })).toEqual(["progress"]);
    expect(columns({ status: "Not started", progress: "x" })).toEqual(["progress"]);
  });

  it("raises it on the status when both are fine and disagree", () => {
    expect(columns({ status: "Done", progress: 50 })).toEqual(["status"]);
  });
});
