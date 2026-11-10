import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildReferenceIndex,
  dateCell,
  describeCell,
  enumCell,
  enumSpec,
  ImportFileError,
  IMPORT_MAX_ERRORS,
  integerCell,
  IssueCollector,
  joinKey,
  matchHeader,
  normalizePhone,
  normalizeText,
  referenceCell,
  RowParser,
  textCell,
  type ImportColumn,
  type RawCell,
} from "../../../src/shared/import/index.js";
import { contactEmail, name, phone } from "../../../src/shared/validation/fields.js";

describe("normalizeText", () => {
  it.each([
    ["  Acme   Co.  ", "acme co."],
    ["ACME CO.", "acme co."],
    ["Acme\tCo.\n", "acme co."],
    ["ＡＣＭＥ", "acme"],
    ["شركة   النور", "شركة النور"],
  ])("turns %j into %j", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe("normalizePhone", () => {
  it.each([
    ["0100 123 4567", "01001234567"],
    ["0100-123-4567", "01001234567"],
    [" +20 100 123-4567 ", "+201001234567"],
  ])("turns %j into %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe("joinKey", () => {
  it("keeps (a, bc) and (ab, c) apart", () => {
    expect(joinKey("a", "bc")).not.toBe(joinKey("ab", "c"));
  });
});

const ok = <T>(value: T) => ({ ok: true, value });
const bad = (code: string, key: string) => ({ ok: false, error: { code, key } });

describe("textCell", () => {
  it("accepts a value the field schema accepts, and returns what the schema returns", () => {
    expect(textCell("  Acme  ", name, { required: true })).toEqual(ok("Acme"));
    expect(textCell("INFO@Example.com", contactEmail, { required: false })).toEqual(ok("info@example.com"));
  });

  it("answers REQUIRED for an empty required cell and nothing for an empty optional one", () => {
    expect(textCell(null, name, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
    expect(textCell(null, name, { required: false })).toEqual(ok(undefined));
  });

  it("answers INVALID_VALUE with the schema's own message key", () => {
    expect(textCell("12", phone, { required: true })).toEqual(
      bad("INVALID_VALUE", "validation.phoneInvalid"),
    );
    expect(textCell("x".repeat(101), name, { required: true })).toEqual(
      bad("INVALID_VALUE", "validation.nameTooLong"),
    );
  });

  it("answers REQUIRED when the schema itself says the value is required", () => {
    const schema = z.string().refine(() => false, { error: "validation.required" });

    expect(textCell("abc", schema, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("answers the generic message for a schema message that is not a translation key", () => {
    expect(textCell("abc", z.string().min(5), { required: true })).toEqual(
      bad("INVALID_VALUE", "validation.invalid"),
    );
  });

  it("refuses a number, a boolean and a date instead of turning them into text", () => {
    for (const cell of [1012345678, true, new Date("2026-01-01")] as RawCell[]) {
      expect(textCell(cell, phone, { required: true })).toEqual(bad("NOT_TEXT", "import.cellNotText"));
    }
  });

  it("refuses an unreadable cell", () => {
    expect(textCell({ unreadable: "error-value" }, name, { required: true })).toEqual(
      bad("UNREADABLE_CELL", "import.cellUnreadable"),
    );
  });
});

describe("enumCell", () => {
  const status = enumSpec(["ACTIVE", "INACTIVE"] as const, { ACTIVE: "Active", INACTIVE: "Inactive" });

  it.each([
    ["ACTIVE", "ACTIVE"],
    ["active", "ACTIVE"],
    ["Active", "ACTIVE"],
    ["  aCtIvE ", "ACTIVE"],
    ["inactive", "INACTIVE"],
    ["INACTIVE", "INACTIVE"],
    ["Inactive", "INACTIVE"],
  ])("reads %j as %s: a code or a label, in any case", (cell, expected) => {
    expect(enumCell(cell, status, { required: true })).toEqual(ok(expected));
  });

  it("refuses anything else with INVALID_OPTION", () => {
    for (const cell of ["Paused", "act", "ACTIVE,INACTIVE", 1, true] as RawCell[]) {
      expect(enumCell(cell, status, { required: false })).toEqual(
        bad("INVALID_OPTION", "import.optionInvalid"),
      );
    }
  });

  it("never reads a number as the text of a code, even when a code looks like one", () => {
    const digits = enumSpec(["1", "2"] as const, { "1": "One", "2": "Two" });

    expect(enumCell("1", digits, { required: true })).toEqual(ok("1"));
    expect(enumCell(1, digits, { required: true })).toEqual(bad("INVALID_OPTION", "import.optionInvalid"));
  });

  it("treats an empty cell as missing", () => {
    expect(enumCell(null, status, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
    expect(enumCell(null, status, { required: false })).toEqual(ok(undefined));
  });

  it("finds a label that differs from its code by more than case", () => {
    const phases = enumSpec(["IN_PROGRESS"] as const, { IN_PROGRESS: "In progress" });

    expect(enumCell("in  PROGRESS", phases, { required: true })).toEqual(ok("IN_PROGRESS"));
    expect(enumCell("in_progress", phases, { required: true })).toEqual(ok("IN_PROGRESS"));
  });
});

describe("integerCell", () => {
  const options = { required: false, min: 0, max: 100, key: "validation.progressInvalid" };
  const invalid = bad("INVALID_VALUE", "validation.progressInvalid");

  it.each([
    [0, 0],
    [40, 40],
    [100, 100],
    ["0", 0],
    ["40", 40],
    [" 100 ", 100],
    ["007", 7],
  ] as [RawCell, number][])("reads %j as %s", (cell, expected) => {
    expect(integerCell(cell, options)).toEqual(ok(expected));
  });

  it.each([
    -1,
    101,
    40.5,
    Number.NaN,
    "101",
    "-1",
    "4.5",
    "40%",
    "forty",
    "1e2",
    "٤٠",
    "99999999999999999999999",
    true,
    new Date(),
  ] as RawCell[])("refuses %j with the message of the column", (cell) => {
    expect(integerCell(cell, options)).toEqual(invalid);
  });

  it("takes the bounds it is given, both inclusive", () => {
    const narrow = { ...options, min: 5, max: 6 };

    expect(integerCell(4, narrow)).toEqual(invalid);
    expect(integerCell(5, narrow)).toEqual(ok(5));
    expect(integerCell("6", narrow)).toEqual(ok(6));
    expect(integerCell(7, narrow)).toEqual(invalid);
  });

  it("treats an empty cell as missing (the reader has already emptied a cell of spaces)", () => {
    expect(integerCell(null, options)).toEqual(ok(undefined));
    expect(integerCell(null, { ...options, required: true })).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("refuses an unreadable cell", () => {
    expect(integerCell({ unreadable: "formula-without-value" }, options)).toEqual(
      bad("UNREADABLE_CELL", "import.cellUnreadable"),
    );
  });
});

describe("dateCell", () => {
  const options = { required: false };
  const invalid = bad("INVALID_VALUE", "validation.calendarDateInvalid");
  const day = (iso: string): Date => new Date(iso + "T00:00:00.000Z");

  it.each([
    ["2026-01-15", "2026-01-15"],
    [" 2026-12-31 ", "2026-12-31"],
    ["2028-02-29", "2028-02-29"],
  ])("reads the text %j as that day at 00:00 UTC", (cell, iso) => {
    expect(dateCell(cell, options)).toEqual(ok(day(iso)));
  });

  it.each([
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-1-5",
    "15/01/2026",
    "2026-01-15T10:00:00Z",
    "tomorrow",
    "0",
  ])("refuses the text %j", (cell) => {
    expect(dateCell(cell, options)).toEqual(invalid);
  });

  it("reads a date cell as its UTC day, dropping the time", () => {
    expect(dateCell(new Date("2026-01-15T00:00:00.000Z"), options)).toEqual(ok(day("2026-01-15")));
    expect(dateCell(new Date("2026-01-15T23:59:59.999Z"), options)).toEqual(ok(day("2026-01-15")));
    expect(dateCell(new Date("2026-01-16T00:00:00.000Z"), options)).toEqual(ok(day("2026-01-16")));
  });

  it("refuses an invalid date, a number and a boolean", () => {
    expect(dateCell(new Date(Number.NaN), options)).toEqual(invalid);
    expect(dateCell(46037, options)).toEqual(invalid);
    expect(dateCell(true, options)).toEqual(invalid);
  });

  it("treats an empty cell as missing", () => {
    expect(dateCell(null, options)).toEqual(ok(undefined));
    expect(dateCell(null, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("refuses an unreadable cell", () => {
    expect(dateCell({ unreadable: "error-value" }, options)).toEqual(
      bad("UNREADABLE_CELL", "import.cellUnreadable"),
    );
  });
});

describe("referenceCell", () => {
  const index = buildReferenceIndex([
    { id: "area-1", name: "New Cairo" },
    { id: "area-2", name: "Sheikh Zayed" },
    { id: "area-3", name: "october gardens" },
    { id: "area-4", name: "October  Gardens" },
  ]);

  it("finds a record by name, ignoring case and extra spaces", () => {
    expect(referenceCell("new cairo", index, { required: true })).toEqual(ok("area-1"));
    expect(referenceCell("  SHEIKH   ZAYED ", index, { required: true })).toEqual(ok("area-2"));
  });

  it("answers REFERENCE_NOT_FOUND for a name nothing has", () => {
    expect(referenceCell("Giza", index, { required: true })).toEqual(
      bad("REFERENCE_NOT_FOUND", "import.referenceNotFound"),
    );
    expect(referenceCell(5, index, { required: true })).toEqual(
      bad("REFERENCE_NOT_FOUND", "import.referenceNotFound"),
    );
  });

  it("answers AMBIGUOUS_REFERENCE when two records have the name, and never picks one", () => {
    expect(referenceCell("October Gardens", index, { required: true })).toEqual(
      bad("AMBIGUOUS_REFERENCE", "import.referenceAmbiguous"),
    );
  });

  it("treats an empty cell as missing", () => {
    expect(referenceCell(null, index, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
    expect(referenceCell(null, index, { required: false })).toEqual(ok(undefined));
  });
});

describe("RowParser", () => {
  it("collects every bad cell of a row and hands back the good values", () => {
    const parser = new RowParser();

    const good = parser.take("name", "Acme", textCell("Acme", name, { required: true }));
    const missing = parser.take("phone", null, textCell(null, phone, { required: true }));
    const wrong = parser.take("email", "nope", textCell("nope", contactEmail, { required: false }));

    expect([good, missing, wrong]).toEqual(["Acme", undefined, undefined]);
    expect(parser.ok).toBe(false);
    expect(parser.issues).toEqual([
      { column: "phone", code: "REQUIRED", key: "validation.required", value: null },
      { column: "email", code: "INVALID_VALUE", key: "validation.emailInvalid", value: "nope" },
    ]);
  });
});

describe("matchHeader", () => {
  const columns: ImportColumn[] = [
    { header: "name", kind: "text", required: true, description: "", example: "" },
    { header: "phone", kind: "text", required: true, description: "", example: "" },
    { header: "status", kind: "text", required: false, description: "", example: "" },
  ];
  const problemOf = (headers: (string | null)[]): ImportFileError => {
    try {
      matchHeader(headers, columns);
    } catch (err) {
      return err as ImportFileError;
    }
    throw new Error("expected a header problem");
  };

  it("returns where each column is, whatever the order", () => {
    expect(matchHeader(["name", "phone", "status"], columns)).toEqual([0, 1, 2]);
    expect(matchHeader(["status", "name", "phone"], columns)).toEqual([1, 2, 0]);
  });

  it("ignores a column that is blank in the header and empty below", () => {
    expect(matchHeader(["name", null, "phone", "status"], columns)).toEqual([0, 2, 3]);
  });

  it("lists every missing column with 400", () => {
    const problem = problemOf(["name"]);

    expect(problem).toMatchObject({
      status: 400,
      code: "IMPORT_HEADER_MISMATCH",
      key: "import.headerMismatch",
    });
    expect(problem.details).toEqual([
      { path: "phone", key: "import.columnMissing" },
      { path: "status", key: "import.columnMissing" },
    ]);
  });

  it("lists every unknown column", () => {
    expect(problemOf(["name", "phone", "status", "notes", "Extra"]).details).toEqual([
      { path: "notes", key: "import.columnUnknown" },
      { path: "Extra", key: "import.columnUnknown" },
    ]);
  });

  it("lists a repeated column", () => {
    expect(problemOf(["name", "phone", "name", "status"]).details).toEqual([
      { path: "name", key: "import.columnDuplicate" },
    ]);
  });

  it("lists missing, repeated and unknown together", () => {
    expect(problemOf(["name", "name", "mobile"]).details).toEqual([
      { path: "phone", key: "import.columnMissing" },
      { path: "status", key: "import.columnMissing" },
      { path: "name", key: "import.columnDuplicate" },
      { path: "mobile", key: "import.columnUnknown" },
    ]);
  });

  it("matches the names exactly: a different case is a missing column and an unknown one", () => {
    expect(problemOf(["Name", "phone", "status"]).details).toEqual([
      { path: "name", key: "import.columnMissing" },
      { path: "Name", key: "import.columnUnknown" },
    ]);
  });

  it("shows an unnamed column that holds data by its letter", () => {
    expect(problemOf(["name", "phone", "status", ""]).details).toEqual([
      { path: "D", key: "import.columnUnknown" },
    ]);
  });

  it("refuses an empty header row", () => {
    expect(problemOf([]).details).toHaveLength(3);
  });
});

describe("describeCell", () => {
  it.each([
    ["Acme", "Acme"],
    [12, "12"],
    [true, "true"],
    [new Date("2026-03-04T05:06:07.000Z"), "2026-03-04T05:06:07.000Z"],
    [null, null],
    [{ unreadable: "error-value" }, null],
  ] as [RawCell, string | null][])("shows %j as %j", (cell, expected) => {
    expect(describeCell(cell)).toBe(expected);
  });

  it("cuts a long value at 200 characters", () => {
    const shown = describeCell("x".repeat(500));

    expect(shown).toHaveLength(201);
    expect(shown?.endsWith("…")).toBe(true);
  });
});

describe("IssueCollector", () => {
  const issue = (column: string, key = "validation.required") => ({
    column,
    code: "REQUIRED" as const,
    key,
    value: null,
  });
  const translate = (key: string) => `[${key}]`;

  it("counts every problem it was given", () => {
    const collector = new IssueCollector(["name"]);
    expect(collector.count).toBe(0);
    collector.add(2, issue("name"));
    collector.add(2, issue("name"));
    collector.add(3, issue("name"));

    expect(collector.count).toBe(3);
  });

  it("reports ok when there is nothing to report", () => {
    expect(new IssueCollector(["name"]).toReport({ total: 3, imported: 3, skipped: 0 }, translate)).toEqual({
      ok: true,
      total: 3,
      imported: 3,
      skipped: 0,
      errors: [],
      truncated: false,
    });
  });

  it("lists errors by row, then by the column's place in the template, in the given language", () => {
    const collector = new IssueCollector(["name", "phone", "email"]);
    collector.add(5, issue("email"));
    collector.add(3, issue("phone", "validation.phoneInvalid"));
    collector.add(5, issue("name"));
    collector.add(3, issue("name"));

    const report = collector.toReport({ total: 5, imported: 0, skipped: 0 }, translate);

    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [3, "name", "[validation.required]"],
      [3, "phone", "[validation.phoneInvalid]"],
      [5, "name", "[validation.required]"],
      [5, "email", "[validation.required]"],
    ]);
  });

  it("lists at most 200 errors and says it left some out", () => {
    const collector = new IssueCollector(["name"]);
    for (let row = 2; row < 2 + IMPORT_MAX_ERRORS + 50; row++) {
      collector.add(row, issue("name"));
    }

    const report = collector.toReport({ total: 250, imported: 0, skipped: 0 }, translate);

    expect(report.errors).toHaveLength(IMPORT_MAX_ERRORS);
    expect(report.truncated).toBe(true);
    expect(report.errors[0]?.row).toBe(2);
    expect(report.errors.at(-1)?.row).toBe(1 + IMPORT_MAX_ERRORS);
    expect(collector.count).toBe(250);
  });

  it("does not say truncated at exactly 200", () => {
    const collector = new IssueCollector(["name"]);
    for (let row = 2; row < 2 + IMPORT_MAX_ERRORS; row++) {
      collector.add(row, issue("name"));
    }

    const report = collector.toReport({ total: 200, imported: 0, skipped: 0 }, translate);

    expect(report.errors).toHaveLength(IMPORT_MAX_ERRORS);
    expect(report.truncated).toBe(false);
  });
});
