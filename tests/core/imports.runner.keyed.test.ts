import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/core/imports/repository.js";
import { ImportRunner, type ImportDefinition } from "../../src/core/imports/runner.js";
import type { RequestContext } from "../../src/core/middleware/requestContext.js";
import { contractorImportDefinition } from "../../src/modules/contractors/service/contractors-import.service.js";
import { dailyReportsImportDefinition } from "../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { openWorksImportDefinition } from "../../src/modules/open-works/service/open-works-import.service.js";
import { smallWorksImportDefinition } from "../../src/modules/small-works/service/small-works-import.service.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

// The key of an import became optional (the daily small works have none). This is the proof that the importers that
// have one run exactly as they did: each of the real definitions of the contractors, the open works and the daily reports
// goes through the real runner, and what a key does is pinned: the keys of the rows, where a duplicate is reported and
// with which message, and that the stored keys are asked for once, with the rows that parsed. The open works, which lost their
// title, and the small works have no key and take identical rows.
const record = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/core/audit/audit.js")>()),
  audit: { record },
}));

const tx = { tx: true } as unknown as Db;
const readDb = { readDb: true } as unknown as Db;
const ctx: RequestContext = { locale: "en", ip: "1.2.3.4", requestId: "req-1" };
const actor = { id: "user-1", role: "EMPLOYEE" as const };
const NOW = new Date("2026-10-27T10:00:00.000Z");

const batches = { lock: vi.fn(), isImported: vi.fn(), create: vi.fn() };
const runner = () =>
  new ImportRunner(batches as never, (async (work: (db: Db) => unknown) => work(tx)) as never, readDb);
const bytesOf = (headers: readonly string[], ...rows: unknown[][]) =>
  workbookOf([[...headers], ...(rows as never[][])]);
const run = async (definition: ImportDefinition<never, never, boolean>, bytes: Buffer, dryRun = false) =>
  runner().run(definition as never, { file: { name: "f.xlsx", bytes }, dryRun, actor, ctx });

beforeEach(() => {
  vi.clearAllMocks();
  batches.lock.mockResolvedValue(undefined);
  batches.isImported.mockResolvedValue(false);
  batches.create.mockResolvedValue({ id: "batch-1" });
  record.mockResolvedValue(undefined);
});

describe("the contractors' import, which has a key", () => {
  const repository = { findByNormalizedNames: vi.fn(), createMany: vi.fn() };
  const definition = () => contractorImportDefinition(repository as never);
  const HEADER = ["Name", "Phone", "Email", "Status"];

  beforeEach(() => {
    repository.findByNormalizedNames.mockResolvedValue([]);
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `c-${n}`));
  });

  it("declares its key: the column, the two messages and both functions", () => {
    expect(definition()).toMatchObject({
      keyColumn: "Name",
      duplicateInFileKey: "import.contractorDuplicateInFile",
      duplicateExistingKey: "import.contractorDuplicateExisting",
      keyOf: expect.any(Function),
      findExisting: expect.any(Function),
    });
  });

  it("reports the later of two rows with the same name and phone on the name column, keeping the first", async () => {
    const outcome = await run(
      definition() as never,
      await bytesOf(
        HEADER,
        ["Nile", "0100 111 2222"],
        ["Delta", "0111 333 4444"],
        [" NILE ", "0100-111-2222"],
      ),
    );

    expect(outcome.status).toBe(422);
    expect(outcome.report.errors).toEqual([
      {
        row: 4,
        column: "Name",
        code: "DUPLICATE_IN_FILE",
        message: "This name and phone appear more than once in the file",
        value: " NILE ",
      },
    ]);
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("reports a stored contractor on the name column, asks for the stored keys once, and saves nothing", async () => {
    repository.findByNormalizedNames.mockResolvedValue([{ name: "Nile", phone: "0100 111 2222" }]);

    const outcome = await run(
      definition() as never,
      await bytesOf(HEADER, ["nile", "0100-111-2222"], ["Delta", "0111 333 4444"]),
    );

    expect(repository.findByNormalizedNames).toHaveBeenCalledTimes(1);
    expect(repository.findByNormalizedNames).toHaveBeenCalledWith(["nile", "delta"], tx);
    expect(outcome.report.errors).toEqual([
      {
        row: 2,
        column: "Name",
        code: "DUPLICATE_EXISTING",
        message: "A contractor with this name and phone already exists",
        value: "nile",
      },
    ]);
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("does not ask for stored keys of rows that did not parse, and saves a good file in file order", async () => {
    await run(definition() as never, await bytesOf(HEADER, ["Nile", "0100 111 2222"], [null, "x"]));
    expect(repository.findByNormalizedNames).toHaveBeenCalledWith(["nile"], tx);

    repository.findByNormalizedNames.mockClear();
    const good = await run(
      definition() as never,
      await bytesOf(HEADER, ["Nile", "0100 111 2222"], ["Delta", "0111 333 4444"]),
    );
    expect(good).toMatchObject({ status: 201, report: { ok: true, imported: 2 } });
    expect(repository.createMany.mock.calls[0]![0].map((row: { name: string }) => row.name)).toEqual([
      "Nile",
      "Delta",
    ]);
  });

  it("checks the keys in a dry run too, against the read client, and writes nothing", async () => {
    repository.findByNormalizedNames.mockResolvedValue([{ name: "Nile", phone: "0100 111 2222" }]);

    const outcome = await run(
      definition() as never,
      await bytesOf(HEADER, ["Nile", "0100 111 2222"], ["Nile", "0100 111 2222"]),
      true,
    );

    expect(outcome.status).toBe(200);
    expect(outcome.report.errors.map((error) => [error.row, error.code])).toEqual([
      [2, "DUPLICATE_EXISTING"],
      [3, "DUPLICATE_IN_FILE"],
      [3, "DUPLICATE_EXISTING"],
    ]);
    expect(repository.findByNormalizedNames).toHaveBeenCalledWith(["nile"], readDb);
    expect(batches.create).not.toHaveBeenCalled();
  });
});

describe("the open works' import, keyed by the villa and the electrical phase", () => {
  const repository = {
    importVillas: vi.fn(),
    importContractors: vi.fn(),
    importElecPhases: vi.fn(),
    lockVillasShared: vi.fn(),
    lockElecPhasesShared: vi.fn(),
    lockVillaPhase: vi.fn(),
    takenVillaPhases: vi.fn(),
    createMany: vi.fn(),
  };
  const definition = () => openWorksImportDefinition(repository as never, actor, ctx);
  const HEADER = [
    "Villa Number",
    "Electrical Phase",
    "Status",
    "Priority",
    "Progress",
    "Contractor",
    "Start Date",
    "End Date",
  ];
  const first = ["P-001", "First fix", "In progress", "Medium", 40];
  const second = ["P-001", "Second fix", "In progress", "Medium", 40];

  beforeEach(() => {
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001", contractorId: null }]);
    repository.importContractors.mockResolvedValue([]);
    repository.importElecPhases.mockResolvedValue([
      { id: "ep1", name: "First fix", status: "ACTIVE" },
      { id: "ep2", name: "Second fix", status: "ACTIVE" },
    ]);
    repository.lockVillasShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, null])),
    );
    repository.lockElecPhasesShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.lockVillaPhase.mockResolvedValue(undefined);
    repository.takenVillaPhases.mockResolvedValue(new Set());
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `w-${n}`));
  });

  it("keys a row by its villa and its electrical phase, reported on the phase column", () => {
    const def = definition();

    expect(def.keyColumn).toBe("Electrical Phase");
    expect(def.keyOf({ villaId: "v1", elecPhaseId: "ep1" } as never)).toBe("v1:ep1");
  });

  it("refuses the same villa and phase twice in the file", async () => {
    const outcome = await run(definition() as never, await bytesOf(HEADER, first, first));

    expect(outcome).toMatchObject({ status: 422, report: { ok: false, total: 2 } });
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("refuses a villa and phase that already have an open work", async () => {
    repository.takenVillaPhases.mockResolvedValue(new Set(["v1:ep1"]));

    const outcome = await run(definition() as never, await bytesOf(HEADER, first, second));

    expect(outcome).toMatchObject({ status: 422, report: { ok: false, total: 2 } });
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("locks the villas, then the phases, then each villa and phase, in a fixed order", async () => {
    const outcome = await run(definition() as never, await bytesOf(HEADER, second, first));

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 2 } });
    expect(repository.lockVillasShared).toHaveBeenCalledWith(["v1"], tx);
    expect(repository.lockElecPhasesShared).toHaveBeenCalledWith(["ep1", "ep2"], tx);
    expect(repository.lockVillaPhase.mock.calls.map(([villa, phase]) => `${villa}:${phase}`)).toEqual([
      "v1:ep1",
      "v1:ep2",
    ]);
  });
});

describe("the daily reports' import, which has a key", () => {
  const repository = {
    userExists: vi.fn(),
    importContractors: vi.fn(),
    importEngineers: vi.fn(),
    existingDays: vi.fn(),
    lockContractorsShared: vi.fn(),
    lockEngineersShared: vi.fn(),
    createMany: vi.fn(),
  };
  const definition = () => dailyReportsImportDefinition(repository as never, actor, ctx, () => NOW);
  const HEADER = ["Report Date", "Contractor", "Electrical Engineer", "Weather", "Workers", "Notes"];
  const cells = (contractor: string, date: string) => [date, contractor, "Mona Hassan", "Sunny", 5];

  beforeEach(() => {
    repository.userExists.mockResolvedValue(true);
    repository.importContractors.mockResolvedValue([
      { id: "c1", name: "Nile Builders", phone: "0100 111 1111", status: "ACTIVE" },
      { id: "c2", name: "Delta Works", phone: "0100 222 2222", status: "ACTIVE" },
    ]);
    repository.importEngineers.mockResolvedValue([
      { id: "x1", name: "Mona Hassan", phone: "0101 111 1111", status: "ACTIVE" },
    ]);
    repository.existingDays.mockResolvedValue([]);
    repository.lockContractorsShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.lockEngineersShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `r-${n}`));
  });

  it("declares its key: the column, the two messages and both functions", () => {
    expect(definition()).toMatchObject({
      keyColumn: "Report Date",
      duplicateInFileKey: "import.dailyReportDuplicateInFile",
      duplicateExistingKey: "import.dailyReportDuplicateExisting",
      keyOf: expect.any(Function),
      findExisting: expect.any(Function),
    });
  });

  it("reports the same contractor and day twice on the reportDate column, however the contractor is written", async () => {
    const outcome = await run(
      definition() as never,
      await bytesOf(
        HEADER,
        cells("Nile Builders", "2026-03-04"),
        cells("Delta Works", "2026-03-04"),
        cells(" nile builders ", "2026-03-04"),
      ),
    );

    expect(outcome.status).toBe(422);
    expect(outcome.report.errors).toEqual([
      {
        row: 4,
        column: "Report Date",
        code: "DUPLICATE_IN_FILE",
        message: "This contractor and date appear more than once in the file",
        value: "2026-03-04",
      },
    ]);
  });

  it("reports a stored day of the contractor on the reportDate column, asking once with the contractors of the file", async () => {
    repository.existingDays.mockResolvedValue([
      { contractorId: "c2", reportDate: new Date("2026-03-04T00:00:00.000Z") },
    ]);

    const outcome = await run(
      definition() as never,
      await bytesOf(HEADER, cells("Nile Builders", "2026-03-04"), cells("Delta Works", "2026-03-04")),
    );

    expect(repository.existingDays).toHaveBeenCalledTimes(1);
    expect(repository.existingDays).toHaveBeenCalledWith(["c1", "c2"], tx);
    expect(outcome.report.errors).toEqual([
      {
        row: 3,
        column: "Report Date",
        code: "DUPLICATE_EXISTING",
        message: "This contractor already has a daily report for this date",
        value: "2026-03-04",
      },
    ]);
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("saves a good file once, after locking the contractors and then the engineers", async () => {
    const outcome = await run(
      definition() as never,
      await bytesOf(
        HEADER,
        cells("Nile Builders", "2026-03-04"),
        cells("Nile Builders", "2026-03-05"),
        cells("Delta Works", "2026-03-04"),
      ),
    );

    expect(outcome).toMatchObject({ status: 201, report: { imported: 3 } });
    expect(repository.lockContractorsShared).toHaveBeenCalledWith(["c1", "c2"], tx);
    expect(repository.lockEngineersShared).toHaveBeenCalledWith(["x1"], tx);
    expect(repository.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("the small works' import, which has no key", () => {
  const repository = {
    userExists: vi.fn(),
    importVillas: vi.fn(),
    importContractors: vi.fn(),
    lockVillasShared: vi.fn(),
    lockContractorsShared: vi.fn(),
    createMany: vi.fn(),
  };
  const definition = () => smallWorksImportDefinition(repository as never, actor, ctx, () => NOW);
  const HEADER = ["Villa Number", "Start Date", "End Date", "Description", "Contractor", "Status"];
  const same = ["P-001", "2026-03-04", "2026-03-06", "Replaced a socket", "Hamdy Co"];

  beforeEach(() => {
    repository.userExists.mockResolvedValue(true);
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001" }]);
    repository.importContractors.mockResolvedValue([
      { id: "c1", name: "Hamdy Co", phone: "0100", status: "ACTIVE" },
    ]);
    repository.lockVillasShared.mockImplementation(async (ids: string[]) => new Set(ids));
    repository.lockContractorsShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `s-${n}`));
  });

  it("declares no key at all", () => {
    const def = definition() as unknown as Record<string, unknown>;

    for (const property of [
      "keyColumn",
      "duplicateInFileKey",
      "duplicateExistingKey",
      "keyOf",
      "findExisting",
    ]) {
      expect(def[property], property).toBeUndefined();
    }
  });

  it("takes two identical rows, and never looks for stored duplicates", async () => {
    const outcome = await run(definition() as never, await bytesOf(HEADER, same, same));

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 2, imported: 2, errors: [] } });
    expect(repository.createMany).toHaveBeenCalledTimes(1);
    expect(repository.createMany.mock.calls[0]![0]).toHaveLength(2);
  });

  it("still guards against the same file twice, through the batch record", async () => {
    batches.isImported.mockResolvedValue(true);

    await expect(run(definition() as never, await bytesOf(HEADER, same))).rejects.toMatchObject({
      statusCode: 409,
      code: "FILE_ALREADY_IMPORTED",
    });
    expect(repository.createMany).not.toHaveBeenCalled();
  });

  it("still reports row errors, and a dry run writes nothing", async () => {
    const bad = await run(
      definition() as never,
      await bytesOf(HEADER, ["P-001", "2026-03-04", "2026-03-06", null, "Hamdy Co"]),
    );
    const dry = await run(definition() as never, await bytesOf(HEADER, same), true);

    expect(bad.status).toBe(422);
    expect(bad.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
      [2, "Description", "REQUIRED"],
    ]);
    expect(dry).toMatchObject({ status: 200, report: { ok: true, imported: 0 } });
    expect(repository.createMany).not.toHaveBeenCalled();
  });
});
