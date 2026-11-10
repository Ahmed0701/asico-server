import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The villas' import on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end
// (in a `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It
// COMMITS inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the import's queries and what it saves (the rows, the progress rows of every phase, the audit entries); that
// a villa made by the import is the same as one made by hand; that a file is saved whole or not at all; and that an import
// running at the same time as another import, a villa created by hand, a phase being created, or a party being switched off
// never deadlocks, never leaves a villa without a progress row, and answers "the data changed" when a row is no longer valid.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import { ElecPhasesService } from "../../src/modules/elec-phases/service/elec-phases.service.js";
import { VillasRepository } from "../../src/modules/villas/repository/villas.repository.js";
import { VillasImportService } from "../../src/modules/villas/service/villas-import.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const HEADER = [
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
];

describe.skipIf(!RUN)("the villas' import on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const importer = new VillasImportService();
  const villas = new VillasService();
  const phases = new ElecPhasesService();
  const actor: Actor = { id: "admin", role: "ADMIN" };

  beforeAll(async () => {
    scratch = await openScratch("scratch15", 6);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES
        ('area1','New Cairo','Cairo',now()), ('area2','Palm Hills','Giza',now()), ('area3','Palm Hills','Alexandria',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","status","updatedAt") VALUES
        ('civ1','Mona Adel','0100 111 2222','ACTIVE',now()), ('civ2','Karim Sami','0100 333 4444','ACTIVE',now()),
        ('civ3','Old Civil','0100 555 6666','INACTIVE',now())`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","status","updatedAt") VALUES
        ('ele1','Hamdy Salah','0111 555 6666','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
        ('con1','Nile Builders','0122 777 8888','ACTIVE',now()), ('con2','Old Co','0122 000 0000','INACTIVE',now())`,
    );
    // Two active phases and one switched off: every villa gets a progress row for each of the three.
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","status","updatedAt") VALUES
        ('ph1','Wiring',1,'ACTIVE',now()), ('ph2','Finishing',2,'ACTIVE',now()), ('ph3','Retired',3,'INACTIVE',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  let fileCounter = 0;
  // A different file every time (by the sheet's name), so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  type Cells = Partial<Record<(typeof HEADER)[number], unknown>>;
  const row = (cells: Cells): unknown[] => HEADER.map((header) => cells[header as keyof Cells] ?? null);
  const villaRow = (number: string | number, plot: string | number, cells: Cells = {}): unknown[] =>
    row({
      "Villa Number": number,
      Area: "New Cairo",
      Block: "B1",
      Plot: plot,
      "Civil Engineer": "Mona Adel",
      ...cells,
    });
  const run = async (file: Buffer, dryRun = false) =>
    importer.importFile(actor, { name: "v.xlsx", bytes: file }, dryRun, ctx);

  // A villa saved by someone else, straight into the table, with a progress row for every phase as every villa has.
  async function saveVilla(
    id: string,
    number: string,
    block: string,
    plot: string,
    areaId = "area1",
  ): Promise<void> {
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
       VALUES ($1,$2,$3,$4,'civ1','admin',$5,now())`,
      [id, number, block, plot, areaId],
    );
    await q(
      `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","version","updatedAt")
       SELECT $1, "id", 0, 1, now() FROM "ElecPhase"`,
      [id],
    );
  }
  const count = async (where: string, values: unknown[] = []): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "Villa" WHERE ${where}`, values)).rows[0].n;
  const statusOf = (result: PromiseSettledResult<{ status: number }>): number =>
    result.status === "fulfilled"
      ? result.value.status
      : result.reason instanceof AppError
        ? result.reason.statusCode
        : 500;
  const codeOf = (result: PromiseSettledResult<unknown>): string | undefined =>
    result.status === "rejected" && result.reason instanceof AppError ? result.reason.code : undefined;
  function assertNoCrash(results: PromiseSettledResult<unknown>[], label: string): void {
    const crashes = results.flatMap((result) =>
      result.status === "rejected" && !(result.reason instanceof AppError && result.reason.statusCode < 500)
        ? [String((result.reason as Error)?.message ?? result.reason)]
        : [],
    );
    expect(crashes, `${label}: nothing may fail with a database error`).toEqual([]);
  }
  // Every villa has a progress row for every phase: the property the phase-set lock exists for.
  async function villasMissingProgress(): Promise<number> {
    return (
      await q(
        `SELECT count(*)::int AS n FROM "Villa" v CROSS JOIN "ElecPhase" ph
         WHERE NOT EXISTS (SELECT 1 FROM "VillaPhaseProgress" p WHERE p."villaId" = v."id" AND p."elecPhaseId" = ph."id")`,
      )
    ).rows[0].n;
  }

  describe("a file of 400 villas", () => {
    // Shaped like the client's sheet: the villa number, the block and the plot are numbers or text, the dates are text or
    // date cells, the budget a number or text, and the people are named by name or by phone.
    const rows = Array.from({ length: 400 }, (_, i) => {
      const n = i + 1;
      return row({
        "Villa Number": n === 1 ? 7001 : `A-${String(n).padStart(3, "0")}`,
        "Owner Name": n % 2 === 0 ? "أحمد علي" : `Owner ${n}`,
        Area: n % 3 === 0 ? " palm  hills , GIZA " : "New Cairo",
        Block: n % 5 === 0 ? 5 : `B${n % 5}`,
        Plot: n,
        Contractor: n % 4 === 0 ? "0122-777-8888" : n % 4 === 1 ? "nile builders" : null,
        "Electrical Engineer": n % 2 === 0 ? "Hamdy Salah" : null,
        "Civil Engineer": n % 7 === 0 ? "0100 333 4444" : "Mona Adel",
        "Start Date": n % 2 === 0 ? "2026-01-15" : new Date("2026-01-15T00:00:00.000Z"),
        "Target Date": "2026-12-31",
        Budget: n % 3 === 0 ? `${n}.25` : n + 0.5,
      });
    });
    let outcome: Awaited<ReturnType<typeof run>>;
    let saved: { id: string; villaNumber: string }[];

    beforeAll(async () => {
      outcome = await run(await fileOf(...rows));
      saved = (
        await q(
          `SELECT "id","villaNumber" FROM "Villa" WHERE "villaNumber" = '7001' OR "villaNumber" LIKE 'A-%' ORDER BY "plot"::int`,
        )
      ).rows as typeof saved;
    }, 120_000);

    it("saves all of them: 201, the report, and the rows", () => {
      expect(outcome.status).toBe(201);
      expect(outcome.report).toMatchObject({ ok: true, total: 400, imported: 400, errors: [] });
      expect(saved).toHaveLength(400);
      expect(saved[0]!.villaNumber).toBe("7001");
      expect(saved[399]!.villaNumber).toBe("A-400");
    });

    it("saves each villa with its values as the file gave them", async () => {
      const get = async (number: string) =>
        (
          await q(
            `SELECT "villaNumber","ownerName","areaId","block","plot","contractorId","electricalEngineerId","civilEngineerId",
                    "startDate"::text AS "startDate","targetDate"::text AS "targetDate","budgetMinor"::text AS "budgetMinor","currency",
                    "createdById","version","updatedAt" IS NOT NULL AS "hasUpdatedAt"
             FROM "Villa" WHERE "villaNumber" = $1`,
            [number],
          )
        ).rows[0];

      expect(await get("7001")).toEqual({
        villaNumber: "7001",
        ownerName: "Owner 1",
        areaId: "area1",
        block: "B1",
        plot: "1",
        contractorId: "con1",
        electricalEngineerId: null,
        civilEngineerId: "civ1",
        startDate: "2026-01-15",
        targetDate: "2026-12-31",
        budgetMinor: "1500",
        currency: "KWD",
        createdById: "admin",
        version: 1,
        hasUpdatedAt: true,
      });
      // Row 21: a number block (5 is "5"... here 21 % 5 = 1, so B1) and 21 % 3 = 0: a text budget and a trailing area city.
      expect(await get("A-021")).toMatchObject({ budgetMinor: "21250", areaId: "area2", plot: "21" });
      // Row 4: Arabic owner, the contractor by phone, an electrical engineer, text dates.
      expect(await get("A-004")).toMatchObject({
        ownerName: "أحمد علي",
        contractorId: "con1",
        electricalEngineerId: "ele1",
        budgetMinor: "4500",
      });
      // Row 5: a number block.
      expect(await get("A-005")).toMatchObject({ block: "5", contractorId: "con1" });
      // Row 7: the civil engineer by phone.
      expect(await get("A-007")).toMatchObject({ civilEngineerId: "civ2", contractorId: null });
    });

    it("gives every villa a progress row at 0 for every phase, the switched-off one too", async () => {
      const ids = saved.map((villa) => villa.id);

      const rowsOf = (
        await q(
          `SELECT "elecPhaseId", count(*)::int AS n, min("progress") AS lo, max("progress") AS hi, min("version") AS v
           FROM "VillaPhaseProgress" WHERE "villaId" = ANY ($1) GROUP BY "elecPhaseId" ORDER BY "elecPhaseId"`,
          [ids],
        )
      ).rows;

      // The migrations start the schema with some phases, and the test adds three: every one of them has a row for every villa.
      const phaseIds = (await q(`SELECT "id" FROM "ElecPhase" ORDER BY "id"`)).rows.map((phase) => phase.id);
      expect(phaseIds.length).toBeGreaterThanOrEqual(3);
      expect(phaseIds).toEqual(expect.arrayContaining(["ph1", "ph2", "ph3"]));
      expect(rowsOf).toEqual(phaseIds.map((elecPhaseId) => ({ elecPhaseId, n: 400, lo: 0, hi: 0, v: 1 })));
    });

    it("writes a villa.create entry for each villa, and one villa.import entry with the ids in the order of the file", async () => {
      const ids = saved.map((villa) => villa.id);

      const created = (
        await q(
          `SELECT "entityId", "after"->>'villaNumber' AS "villaNumber", "actorId" FROM "AuditLog"
           WHERE "action" = 'villa.create' AND "entityId" = ANY ($1) ORDER BY "createdAt", "id"`,
          [ids],
        )
      ).rows;
      const imports = (
        await q(
          `SELECT "entity", "actorId", "after" FROM "AuditLog" WHERE "action" = 'villa.import' ORDER BY "createdAt" DESC LIMIT 1`,
        )
      ).rows;

      expect(new Set(created.map((entry) => entry.entityId))).toEqual(new Set(ids));
      expect(created).toHaveLength(400);
      expect(created.every((entry) => entry.actorId === "admin")).toBe(true);
      expect(imports[0]).toMatchObject({ entity: "Villa", actorId: "admin", after: { rows: 400 } });
      expect(imports[0].after.createdIds).toEqual(ids);
      const batch = (await q(`SELECT "entity","rows","userId" FROM "ImportBatch"`)).rows;
      expect(batch).toContainEqual({ entity: "Villa", rows: 400, userId: "admin" });
    });

    it("shows the same villas in a changed file as duplicates, and saves nothing more", async () => {
      await expect(run(await fileOf(...rows))).resolves.toMatchObject({ status: 422 });
      expect(await count(`"villaNumber" LIKE 'A-%'`)).toBe(399);
    });
  });

  describe("a villa made by the import and one made by hand", () => {
    it("leave the same values, the same progress rows and the same kind of audit entry", async () => {
      const common = {
        ownerName: "Same Owner",
        areaId: "area1",
        block: "SB",
        civilEngineerId: "civ1",
        electricalEngineerId: "ele1",
        contractorId: "con1",
        startDate: new Date("2026-02-01T00:00:00.000Z"),
        targetDate: new Date("2026-08-01T00:00:00.000Z"),
        budgetMinor: 123_456_789,
        currency: "KWD",
      };
      const byHand = await villas.create(actor, { ...common, villaNumber: "HAND-1", plot: "H1" }, ctx);
      await run(
        await fileOf(
          villaRow("IMPORT-1", "I1", {
            "Owner Name": "Same Owner",
            Block: "SB",
            Contractor: "Nile Builders",
            "Electrical Engineer": "Hamdy Salah",
            "Start Date": "2026-02-01",
            "Target Date": "2026-08-01",
            Budget: 123_456.789,
          }),
        ),
      );
      const importedId = (await q(`SELECT "id" FROM "Villa" WHERE "villaNumber" = 'IMPORT-1'`)).rows[0]
        .id as string;

      const columns = `"ownerName","areaId","block","civilEngineerId","electricalEngineerId","contractorId","startDate"::text AS "startDate",
        "targetDate"::text AS "targetDate","budgetMinor"::text AS "budgetMinor","currency","createdById","version"`;
      const handRow = (await q(`SELECT ${columns} FROM "Villa" WHERE "id" = $1`, [byHand.id])).rows[0];
      const importRow = (await q(`SELECT ${columns} FROM "Villa" WHERE "id" = $1`, [importedId])).rows[0];
      expect(importRow).toEqual(handRow);

      const progressOf = async (id: string) =>
        (
          await q(
            `SELECT "elecPhaseId","progress","version","completedAt" FROM "VillaPhaseProgress" WHERE "villaId" = $1 ORDER BY "elecPhaseId"`,
            [id],
          )
        ).rows;
      expect(await progressOf(importedId)).toEqual(await progressOf(byHand.id));

      const afterOf = async (id: string) =>
        (
          await q(
            `SELECT "after","before","entity","action" FROM "AuditLog" WHERE "entityId" = $1 AND "action" = 'villa.create'`,
            [id],
          )
        ).rows[0];
      const handAudit = await afterOf(byHand.id);
      const importAudit = await afterOf(importedId);
      expect(Object.keys(importAudit.after).sort()).toEqual(Object.keys(handAudit.after).sort());
      expect({ ...importAudit.after, villaNumber: "", plot: "" }).toEqual({
        ...handAudit.after,
        villaNumber: "",
        plot: "",
      });
      expect([importAudit.before, importAudit.entity]).toEqual([handAudit.before, handAudit.entity]);
    });
  });

  describe("checks against what is stored", () => {
    it("reports a stored villa number in any case and a stored place on the Plot column, in a dry run too, saving nothing", async () => {
      await saveVilla("stored1", "Stored-1", "SB9", "9");
      const file = await fileOf(
        villaRow("stored-1", "1", { Block: "S1" }),
        villaRow("Fresh-1", 9, { Block: "sb9" }),
        villaRow("Fresh-2", 10, { Block: "sb9" }),
      );

      const dry = await run(file, true);
      const real = await run(file);

      for (const outcome of [dry, real]) {
        expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
          [2, "Villa Number", "DUPLICATE_EXISTING"],
          [3, "Plot", "DUPLICATE_EXISTING"],
        ]);
      }
      expect([dry.status, real.status]).toEqual([200, 422]);
      expect(await count(`"villaNumber" LIKE 'Fresh-%'`)).toBe(0);
    });

    it("does not mix up two areas of one name: the city says which", async () => {
      await saveVilla("stored2", "Stored-2", "PB", "1", "area2");

      const outcome = await run(
        await fileOf(
          villaRow("Palm-A", 1, { Area: "Palm Hills, Alexandria", Block: "PB" }),
          villaRow("Palm-B", 1, { Area: "Palm Hills, Giza", Block: "PB" }),
          villaRow("Palm-C", 2, { Area: "Palm Hills", Block: "PB" }),
        ),
      );

      expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [3, "Plot", "DUPLICATE_EXISTING"],
        [4, "Area", "AMBIGUOUS_REFERENCE"],
      ]);
    });

    it("refuses a switched-off area party and one that does not exist, and creates nothing", async () => {
      const outcome = await run(
        await fileOf(
          villaRow("Gone-1", 1, { "Civil Engineer": "Old Civil" }),
          villaRow("Gone-2", 2, { Contractor: "Old Co" }),
          villaRow("Gone-3", 3, { Contractor: "Nobody", Area: "Nowhere" }),
        ),
      );

      expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [2, "Civil Engineer", "INVALID_VALUE"],
        [3, "Contractor", "INVALID_VALUE"],
        [4, "Area", "REFERENCE_NOT_FOUND"],
        [4, "Contractor", "REFERENCE_NOT_FOUND"],
      ]);
      expect(await count(`"villaNumber" LIKE 'Gone-%'`)).toBe(0);
    });
  });

  describe("the data changes between the check and the save", () => {
    // What another request does after the file was checked: it commits on its own connection just before the import takes its
    // locks (the first thing the save does).
    const happensBeforeSave = (action: () => Promise<unknown>): void => {
      const original = VillasRepository.prototype.lockPhaseSet;
      vi.spyOn(VillasRepository.prototype, "lockPhaseSet").mockImplementationOnce(async function (
        this: VillasRepository,
        ...args: Parameters<VillasRepository["lockPhaseSet"]>
      ) {
        await action();
        return original.apply(this, args);
      });
    };
    const rejected = async (promise: Promise<unknown>): Promise<AppError> => {
      try {
        await promise;
      } catch (err) {
        return err as AppError;
      }
      throw new Error("expected the import to be refused");
    };
    const nothingSavedFor = async (prefix: string): Promise<void> => {
      expect(await count(`"villaNumber" LIKE $1`, [`${prefix}%`])).toBe(0);
      expect(
        (
          await q(
            `SELECT count(*)::int AS n FROM "VillaPhaseProgress" p JOIN "Villa" v ON v."id" = p."villaId" WHERE v."villaNumber" LIKE $1`,
            [`${prefix}%`],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await q(
            `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'villa.create' AND "after"->>'villaNumber' LIKE $1`,
            [`${prefix}%`],
          )
        ).rows[0].n,
      ).toBe(0);
    };

    it("answers 409 IMPORT_DATA_CHANGED, saving nothing, when a villa with one of the numbers is saved in the meantime", async () => {
      const file = await fileOf(
        villaRow("Race-1-a", 1, { Block: "R1" }),
        villaRow("Race-1-b", 2, { Block: "R1" }),
      );
      happensBeforeSave(() => saveVilla("race1", "Race-1-b", "RX", "1"));

      const err = await rejected(run(file));

      expect([err.statusCode, err.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
      await nothingSavedFor("Race-1-a");
      expect(await count(`"id" = 'race1'`)).toBe(1);
      // The next upload of the same file shows the row as a duplicate, as the message promises.
      expect((await run(file)).report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [3, "Villa Number", "DUPLICATE_EXISTING"],
      ]);
    });

    it("answers 409 IMPORT_DATA_CHANGED when a villa is saved on one of the places in the meantime", async () => {
      happensBeforeSave(() => saveVilla("race2", "Other-2", "R2", "1"));

      const err = await rejected(run(await fileOf(villaRow("Race-2", 1, { Block: "R2" }))));

      expect([err.statusCode, err.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
      await nothingSavedFor("Race-2");
    });

    it.each([
      [
        "a civil engineer is switched off",
        `UPDATE "CivilEngineer" SET "status" = 'INACTIVE' WHERE "id" = 'civ2'`,
        `UPDATE "CivilEngineer" SET "status" = 'ACTIVE' WHERE "id" = 'civ2'`,
        { "Civil Engineer": "Karim Sami" },
      ],
      [
        "an electrical engineer is switched off",
        `UPDATE "ElectricalEngineer" SET "status" = 'INACTIVE' WHERE "id" = 'ele1'`,
        `UPDATE "ElectricalEngineer" SET "status" = 'ACTIVE' WHERE "id" = 'ele1'`,
        { "Electrical Engineer": "Hamdy Salah" },
      ],
      [
        "a contractor is switched off",
        `UPDATE "Contractor" SET "status" = 'INACTIVE' WHERE "id" = 'con1'`,
        `UPDATE "Contractor" SET "status" = 'ACTIVE' WHERE "id" = 'con1'`,
        { Contractor: "Nile Builders" },
      ],
    ] as const)(
      "answers 409 IMPORT_DATA_CHANGED, saving nothing, when %s in the meantime",
      async (_name, change, restore, cells) => {
        happensBeforeSave(() => q(change));

        try {
          const err = await rejected(
            run(await fileOf(villaRow(`Race-3-${_name.length}`, 1, { Block: "R3", ...cells }))),
          );

          expect([err.statusCode, err.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
          await nothingSavedFor("Race-3-");
        } finally {
          await q(restore);
        }
      },
    );

    it("answers 409 IMPORT_DATA_CHANGED when the area is deleted in the meantime", async () => {
      await q(
        `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area-tmp','Temporary','Cairo',now())`,
      );
      happensBeforeSave(() => q(`DELETE FROM "Area" WHERE "id" = 'area-tmp'`));

      const err = await rejected(
        run(await fileOf(villaRow("Race-4", 1, { Area: "Temporary", Block: "R4" }))),
      );

      expect([err.statusCode, err.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
      await nothingSavedFor("Race-4");
    });

    it("is not stopped by a change to a party the file does not use", async () => {
      happensBeforeSave(() => q(`UPDATE "CivilEngineer" SET "status" = 'INACTIVE' WHERE "id" = 'civ3'`));

      const outcome = await run(await fileOf(villaRow("Race-5", 1, { Block: "R5" })));

      expect(outcome.status).toBe(201);
    });

    it("makes a switch-off of a party the import holds wait for the import: the import saw it active, the switch-off follows", async () => {
      // The import holds its shared locks while it saves; the test pauses it there.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: () => void;
      const paused = new Promise<void>((resolve) => (holding = resolve));
      const original = VillasRepository.prototype.createMany;
      vi.spyOn(VillasRepository.prototype, "createMany").mockImplementationOnce(async function (
        this: VillasRepository,
        ...args: Parameters<VillasRepository["createMany"]>
      ) {
        holding();
        await released;
        return original.apply(this, args);
      });
      const importing = run(
        await fileOf(
          villaRow("Hold-1", 1, { Block: "H1", "Civil Engineer": "Karim Sami", Contractor: "Nile Builders" }),
        ),
      );
      await paused;

      // The switch-off goes to its own connection, and waits for the import's shared locks.
      let switchedOff = false;
      const switchOff = q(`UPDATE "CivilEngineer" SET "status" = 'INACTIVE' WHERE "id" = 'civ2'`).then(
        () => (switchedOff = true),
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(switchedOff, "the switch-off waits for the import").toBe(false);
      } finally {
        release();
      }
      const outcome = await importing;
      await switchOff;

      expect(outcome.status).toBe(201);
      expect(switchedOff).toBe(true);
      expect(await count(`"villaNumber" = 'Hold-1'`)).toBe(1);
      await q(`UPDATE "CivilEngineer" SET "status" = 'ACTIVE' WHERE "id" = 'civ2'`);
    });
    it("holds the area shared while it saves: a writer to the area waits for the import, a reader that shares it does not", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: () => void;
      const paused = new Promise<void>((resolve) => (holding = resolve));
      const original = VillasRepository.prototype.createMany;
      vi.spyOn(VillasRepository.prototype, "createMany").mockImplementationOnce(async function (
        this: VillasRepository,
        ...args: Parameters<VillasRepository["createMany"]>
      ) {
        holding();
        await released;
        return original.apply(this, args);
      });
      const importing = run(await fileOf(villaRow("Hold-2", 1, { Block: "H2" })));
      await paused;

      const within = <T>(promise: Promise<T>, ms: number): Promise<"done" | "waiting"> =>
        Promise.race([
          promise.then(() => "done" as const),
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms)),
        ]);
      let renamed = false;
      try {
        // Creating a villa by hand takes the area shared too (a villa and the import can share it).
        expect(await within(q(`SELECT "id" FROM "Area" WHERE "id" = 'area1' FOR SHARE`), 500)).toBe("done");
        const rename = q(`UPDATE "Area" SET "updatedAt" = now() WHERE "id" = 'area1'`).then(
          () => (renamed = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(renamed, "a change to the area waits for the import").toBe(false);
        release();
        await rename;
      } finally {
        release();
      }
      const outcome = await importing;

      expect(outcome.status).toBe(201);
      expect(renamed).toBe(true);
      expect(await count(`"villaNumber" = 'Hold-2'`)).toBe(1);
    });
  });

  describe("imports and writes at the same time", () => {
    const thirty = (prefix: string, first = 1) =>
      Array.from({ length: 30 }, (_, i) => villaRow(`${prefix}-${first + i}`, first + i, { Block: prefix }));

    it("takes the same file once when two arrive together: one saved, the other FILE_ALREADY_IMPORTED", async () => {
      const file = await fileOf(...thirty("Twice"));

      const results = await Promise.allSettled([run(file), run(file)]);

      assertNoCrash(results, "the same file twice");
      expect(results.map(statusOf).sort()).toEqual([201, 409]);
      expect(results.map(codeOf).filter(Boolean)).toEqual(["FILE_ALREADY_IMPORTED"]);
      expect(await count(`"villaNumber" LIKE 'Twice-%'`)).toBe(30);
    });

    it("lets one of two files with a villa in common in, and shows the other the duplicate", async () => {
      const first = await fileOf(...thirty("Over"), villaRow("Over-shared", 100, { Block: "Over" }));
      const second = await fileOf(...thirty("Over2"), villaRow("over-SHARED", 101, { Block: "Over" }));

      const results = await Promise.allSettled([run(first), run(second)]);

      assertNoCrash(results, "two files that overlap");
      expect(results.map(statusOf).sort()).toEqual([201, 422]);
      expect(await count(`"villaNumber" ILIKE 'over-shared'`)).toBe(1);
      // Whichever lost saved none of its villas.
      expect(await count(`"villaNumber" ILIKE 'over%'`)).toBe(31);
    });

    it("never leaves a villa without a progress row for a phase, whether the villas come from an import, a hand or a phase is added", async () => {
      const byHand = (n: number) =>
        villas.create(
          actor,
          {
            villaNumber: `Mix-hand-${n}`,
            areaId: "area1",
            block: "MX",
            plot: String(n),
            civilEngineerId: "civ1",
          },
          ctx,
        );
      const results = await Promise.allSettled([
        run(await fileOf(...thirty("Mix", 1))),
        run(await fileOf(...thirty("Mix2", 1))),
        phases.create(actor, { name: `Mix phase ${fileCounter}` }, ctx),
        byHand(1),
        byHand(2),
        phases.create(actor, { name: `Mix phase ${fileCounter + 1}` }, ctx),
        byHand(3),
      ]);

      assertNoCrash(results, "imports, villas and phases together");
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      expect(await villasMissingProgress()).toBe(0);
      expect(await count(`"villaNumber" LIKE 'Mix%'`)).toBe(63);
    });

    it("saves 2,000 villas in one import, with a progress row of every phase for each", async () => {
      const big = Array.from({ length: 2000 }, (_, i) =>
        villaRow(`Big-${i}`, i, { Block: `G${Math.floor(i / 100)}` }),
      );

      const outcome = await run(await fileOf(...big));

      expect(outcome.status).toBe(201);
      expect(await count(`"villaNumber" LIKE 'Big-%'`)).toBe(2000);
      expect(await villasMissingProgress()).toBe(0);
    }, 120_000);
  });
});
