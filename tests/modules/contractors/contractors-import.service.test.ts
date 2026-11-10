import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../../src/core/i18n/locales/ar.json" with { type: "json" };
import en from "../../../src/core/i18n/locales/en.json" with { type: "json" };
import {
  CONTRACTOR_IMPORT_COLUMNS,
  contractorImportDefinition,
  contractorKey,
} from "../../../src/modules/contractors/service/contractors-import.service.js";
import {
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
} from "../../../src/shared/import/index.js";
import {
  addContractor,
  contractorTables,
  InMemoryContractorsRepository,
} from "./in-memory-contractors.repository.js";

const repository = new InMemoryContractorsRepository();
const definition = contractorImportDefinition(repository as never);
const db = {} as never;

beforeEach(() => {
  contractorTables.reset();
});

// The cells of a row are named by short keys here; the import reads them under the headers of the template.
const TITLE: Record<string, string> = { name: "Name", phone: "Phone", email: "Email", status: "Status" };
const cells = (overrides: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries({ name: "Acme", phone: "0100 123 4567", email: null, status: null, ...overrides }).map(
      ([key, value]) => [TITLE[key], value],
    ),
  ) as never;

describe("the contractors import columns", () => {
  it("are name, phone, email and status, in that order, with name and phone required", () => {
    expect(CONTRACTOR_IMPORT_COLUMNS.map((c) => [c.header, c.required])).toEqual([
      ["Name", true],
      ["Phone", true],
      ["Email", false],
      ["Status", false],
    ]);
  });

  it("offer the status labels as the dropdown", () => {
    expect(CONTRACTOR_IMPORT_COLUMNS[3]).toMatchObject({ values: ["Active", "Inactive"] });
  });

  it("have an example row that is itself a valid row", () => {
    const example = Object.fromEntries(CONTRACTOR_IMPORT_COLUMNS.map((c) => [c.header, c.example]));

    const parsed = definition.parseRow(example, undefined);

    expect(parsed.issues).toEqual([]);
    expect(parsed.value).toEqual({
      name: "Example Contracting Co.",
      phone: "0100 123 4567",
      email: "info@example.com",
      status: "ACTIVE",
    });
  });
});

describe("parseRow", () => {
  it("trims the name and the phone, lowercases the email, and defaults the status to ACTIVE", () => {
    const { value, issues } = definition.parseRow(
      cells({ name: "  Acme Co.  ", phone: " 0100 123 4567 ", email: " Info@Acme.TEST " }),
      undefined,
    );

    expect(issues).toEqual([]);
    expect(value).toEqual({
      name: "Acme Co.",
      phone: "0100 123 4567",
      email: "info@acme.test",
      status: "ACTIVE",
    });
  });

  it("reads an empty email as none", () => {
    expect(definition.parseRow(cells({ email: null }), undefined).value?.email).toBeNull();
  });

  it("gives no value, and every issue, for a bad row", () => {
    const { value, issues } = definition.parseRow(
      cells({ name: null, phone: "1", email: "nope", status: "paused" }),
      undefined,
    );

    expect(value).toBeUndefined();
    expect(issues.map((i) => [i.column, i.code])).toEqual([
      ["Name", "REQUIRED"],
      ["Phone", "INVALID_VALUE"],
      ["Email", "INVALID_VALUE"],
      ["Status", "INVALID_OPTION"],
    ]);
  });

  it("accepts the same name and phone limits as creating a contractor", () => {
    expect(definition.parseRow(cells({ name: "x".repeat(100) }), undefined).issues).toEqual([]);
    expect(definition.parseRow(cells({ name: "x".repeat(101) }), undefined).issues).toHaveLength(1);
    expect(definition.parseRow(cells({ phone: "12345" }), undefined).issues).toEqual([]);
    expect(definition.parseRow(cells({ phone: "1234" }), undefined).issues).toHaveLength(1);
    expect(definition.parseRow(cells({ email: `${"a".repeat(250)}@b.co` }), undefined).issues).toHaveLength(
      1,
    );
  });
});

describe("contractorKey", () => {
  it.each([
    [
      { name: "Acme Co.", phone: "0100 123 4567" },
      { name: "  ACME   co. ", phone: "0100-123-4567" },
    ],
    [
      { name: "شركة النور", phone: "+20 100 1234567" },
      { name: "شركة   النور", phone: "+201001234567" },
    ],
  ])("is the same for %j and %j", (a, b) => {
    expect(contractorKey(a)).toBe(contractorKey(b));
  });

  it.each([
    [
      { name: "Acme", phone: "0100 123 4567" },
      { name: "Acme", phone: "0100 123 4568" },
    ],
    [
      { name: "Acme", phone: "0100 123 4567" },
      { name: "Acme Co", phone: "0100 123 4567" },
    ],
    [
      { name: "A", phone: "1B12345" },
      { name: "A1", phone: "B12345" },
    ],
  ])("differs for %j and %j", (a, b) => {
    expect(contractorKey(a)).not.toBe(contractorKey(b));
  });
});

describe("findExisting", () => {
  const row = (name: string, phone: string) => ({ name, phone, email: null, status: "ACTIVE" as const });

  it("finds the stored contractors that have the same name and phone, however they were typed", async () => {
    addContractor({ name: "  Acme   Co. ", phone: "0100-123-4567" });
    addContractor({ name: "Bolt", phone: "0111 222 3333" });

    const found = await definition.findExisting(
      [row("ACME CO.", "0100 123 4567"), row("Bolt", "0199 999 9999")],
      db,
    );

    // The set holds the keys of the stored contractors that share a name with a row; a row is a duplicate only if
    // its own key is in it.
    expect(found.has(contractorKey(row("ACME CO.", "0100 123 4567")))).toBe(true);
    expect(found.has(contractorKey(row("Bolt", "0199 999 9999")))).toBe(false);
  });

  it("finds nothing when no name matches, and asks nothing when there are no rows", async () => {
    addContractor({ name: "Acme", phone: "0100 123 4567" });

    expect((await definition.findExisting([row("Other", "0100 123 4567")], db)).size).toBe(0);
    expect((await definition.findExisting([], db)).size).toBe(0);
  });

  it("looks the names up once, lowercased and without repeats", async () => {
    const spy = vi.spyOn(repository, "findByNormalizedNames");

    await definition.findExisting(
      [row("Acme  Co", "11111"), row("ACME CO", "22222"), row("Bolt", "33333")],
      db,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(["acme co", "bolt"], db);
  });
});

describe("the messages", () => {
  const locales = { en, ar } as Record<string, Record<string, string>>;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
  }
  const root = fileURLToPath(new URL("../../../src/", import.meta.url));
  const files = [
    ...sourceFiles(join(root, "shared", "import")),
    ...sourceFiles(join(root, "core", "imports")),
    join(root, "core", "middleware", "importUpload.ts"),
    join(root, "modules", "contractors", "service", "contractors-import.service.ts"),
    join(root, "modules", "contractors", "controller", "contractors-import.controller.ts"),
  ];
  const used = new Set(
    files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/"((?:import|errors|validation)\.[A-Za-z0-9]+)"/g)].map(
        (m) => m[1]!,
      ),
    ),
  );

  it("find every translation key the import code uses, in English and in Arabic", () => {
    expect([...used].length).toBeGreaterThan(15);
    for (const key of used) {
      expect(locales.en?.[key], `en: ${key}`).toBeTypeOf("string");
      expect(locales.ar?.[key], `ar: ${key}`).toBeTypeOf("string");
    }
  });

  it("name the limits the code enforces", () => {
    for (const language of ["en", "ar"]) {
      const messages = locales[language]!;
      expect(messages["import.tooManyRows"]).toContain(IMPORT_MAX_ROWS.toLocaleString("en-US"));
      expect(messages["import.tooManyColumns"]).toContain(String(IMPORT_MAX_COLUMNS));
      expect(messages["import.cellTooLong"]).toContain(IMPORT_MAX_CELL_CHARS.toLocaleString("en-US"));
    }
  });
});
