import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_TRANSACTION_TIMEOUT_MS, ImportRunner } from "../../src/core/imports/runner.js";
import { name } from "../../src/shared/validation/fields.js";
import { joinKey, normalizeText, RowParser, textCell } from "../../src/shared/import/index.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../src/core/database/prisma.js", () => ({ prisma: { $transaction: database.transaction } }));
vi.mock("../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));

const batches = {
  lock: vi.fn(async () => undefined),
  isImported: vi.fn(async () => false),
  create: vi.fn(async () => ({ id: "batch-1" })),
};

beforeEach(() => {
  vi.clearAllMocks();
  database.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
    work({ tx: true }),
  );
});

describe("the runner's own transaction", () => {
  it("gives a real import more time than the default, so a large file can finish", async () => {
    const runner = new ImportRunner(batches as never);
    const bytes = await workbookOf([["name"], ["Acme"]]);

    const outcome = await runner.run(
      {
        entity: "Thing",
        action: "thing.import",
        sheetName: "Things",
        plural: "things",
        fileName: "things.xlsx",
        columns: [{ header: "name", kind: "text", required: true, description: "", example: "" }],
        keyColumn: "name",
        duplicateInFileKey: "import.contractorDuplicateInFile",
        duplicateExistingKey: "import.contractorDuplicateExisting",
        loadLookups: async () => ({}),
        parseRow: (cells) => {
          const parser = new RowParser();
          const value = parser.take(
            "name",
            cells.name ?? null,
            textCell(cells.name ?? null, name, { required: true }),
          );
          return value === undefined
            ? { value: undefined, issues: parser.issues }
            : { value: { name: value }, issues: [] };
        },
        keyOf: (row) => joinKey(normalizeText(row.name)),
        findExisting: async () => new Set<string>(),
        insert: async (rows) => rows.map((_, index) => `id-${index}`),
      },
      {
        file: { name: "things.xlsx", bytes },
        dryRun: false,
        actor: { id: "u1", role: "EMPLOYEE" },
        ctx: { locale: "en", ip: "1.2.3.4", requestId: "r1" },
      },
    );

    expect(outcome.status).toBe(201);
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.transaction.mock.calls[0]?.[1]).toEqual({ timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5_000);
  });
});
