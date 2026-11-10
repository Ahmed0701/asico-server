import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_ERROR_CODES,
  IMPORT_LONG_TEXT_CELL_CHARS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ERRORS,
  IMPORT_MAX_ROWS,
} from "../../src/shared/import/index.js";
import { EXPORT_MAX_ROWS } from "../../src/shared/export/types.js";
import { code, doc, tables } from "./source.js";

// docs/imports-exports.md lists, for each of the twelve exports, the file it makes and the columns of its header, and for each of
// the seven imports the columns of its template, which are required, and the limits. The files are made by the real code over
// empty data and read back.

vi.mock("../../src/core/database/prisma.js", () => ({
  prisma: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
}));
vi.mock("../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<object>()),
  audit: { record: vi.fn() },
}));

const grouped = (n: number): string => n.toLocaleString("en-US");

describe("docs/imports-exports.md", async () => {
  const { exportFiles, templates } = await import("./harness.js");
  const exported = await exportFiles();
  const imported = await templates();

  it("lists the twelve exports with their file, their sheet and their columns, in order", () => {
    const rows = new Map<string, string[]>();
    for (const { table } of tables(doc("imports-exports.md"))) {
      if (table.header[0] !== "Route") continue;
      for (const row of table.rows) rows.set(code(row[0] ?? "").replace(/^GET /, ""), row);
    }
    expect([...rows.keys()].sort()).toEqual(exported.map((file) => file.route).sort());
    for (const file of exported) {
      const row = rows.get(file.route)!;
      expect(code(row[2] ?? ""), `${file.route} file`).toBe(file.fileStem);
      expect(code(row[3] ?? ""), `${file.route} sheet`).toBe(file.sheet);
      expect((row[4] ?? "").split(", "), `${file.route} columns`).toEqual(file.headers);
    }
  });

  it("lists the columns of the seven import templates, in order, with which are required", () => {
    const sections = new Map<string, { columns: string[]; required: boolean[] }>();
    for (const { markers, table } of tables(doc("imports-exports.md"))) {
      if (table.header[0] !== "Column" || markers["import"] === undefined) continue;
      sections.set(markers["import"], {
        columns: table.rows.map((row) => code(row[0] ?? "")),
        required: table.rows.map((row) => (row[1] ?? "").trim() === "Yes"),
      });
    }
    expect([...sections.keys()].sort()).toEqual(imported.map((template) => template.name).sort());
    for (const template of imported) {
      const section = sections.get(template.name)!;
      expect(section.columns, `${template.name} columns`).toEqual(
        template.columns.map((column) => column.header),
      );
      expect(section.required, `${template.name} required`).toEqual(
        template.columns.map((column) => column.required),
      );
    }
  });

  it("lists, for each import, the columns its export has after the template's, and the export begins with the template", () => {
    const listed = new Map<string, string[]>();
    for (const { table } of tables(doc("imports-exports.md"))) {
      if (table.header[0] !== "Import" || table.header[2] !== "Informational columns (export only)") continue;
      for (const row of table.rows) {
        listed.set(
          (row[0] ?? "").toLowerCase().replace(/ /g, "-"),
          // "none": an import whose export is its template with the data in it.
          (row[2] ?? "") === "none" ? [] : (row[2] ?? "").split(", ").map((column) => code(column)),
        );
      }
    }
    expect([...listed.keys()].sort()).toEqual(imported.map((template) => template.name).sort());
    for (const template of imported) {
      const header = exported.find((file) => file.route === `/${template.name}/export`)!.headers;
      const importable = template.columns.map((column) => column.header);
      // The villas template ends with the optional Currency, which the export writes too, before the informational ones.
      expect(header.slice(0, importable.length), `${template.name} importable`).toEqual(importable);
      expect(listed.get(template.name), `${template.name} informational`).toEqual(
        header.slice(importable.length),
      );
    }
  });

  it("documents the skipped count of the report", () => {
    expect(doc("imports-exports.md")).toContain('"skipped": 0');
    expect(doc("imports-exports.md")).toContain("`skipped` is the number of rows left out on purpose");
  });

  it("states the limits as the code has them", () => {
    const limits = new Map<string, string>();
    for (const { table } of tables(doc("imports-exports.md"))) {
      if (table.header[0] !== "Limit") continue;
      for (const row of table.rows) limits.set(row[0] ?? "", row[1] ?? "");
    }
    expect(limits.get("Data rows")).toContain(grouped(IMPORT_MAX_ROWS));
    expect(limits.get("Columns")).toContain(String(IMPORT_MAX_COLUMNS));
    expect(limits.get("Characters in a cell")).toContain(grouped(IMPORT_MAX_CELL_CHARS));
    expect(limits.get("Characters in a long-text cell")).toContain(grouped(IMPORT_LONG_TEXT_CELL_CHARS));
    expect(limits.get("File size")).toContain(`${IMPORT_MAX_BYTES / (1024 * 1024)} MB`);
    expect(limits.get("Errors listed in a report")).toContain(String(IMPORT_MAX_ERRORS));
    expect(limits.get("Records in an export")).toContain(grouped(EXPORT_MAX_ROWS));
  });

  it("lists every row error code", () => {
    const listed: string[] = [];
    for (const { table } of tables(doc("imports-exports.md"))) {
      if (table.header[0] !== "Row error") continue;
      for (const row of table.rows) listed.push(code(row[0] ?? ""));
    }
    expect(listed.sort()).toEqual([...IMPORT_ERROR_CODES].sort());
  });
});
