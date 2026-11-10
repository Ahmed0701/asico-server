import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The open works' import on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end
// (in a `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It
// COMMITS inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the import's queries; that a file is saved whole or not at all; and that an import running at the same
// time as a change of a villa's contractor, a delete of a villa, a progress update, a manual write or another import
// never deadlocks and leaves nothing half saved.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import { OpenWorksImportService } from "../../src/modules/open-works/service/open-works-import.service.js";
import { OpenWorksService } from "../../src/modules/open-works/service/open-works.service.js";
import { VillaProgressService } from "../../src/modules/villa-progress/service/villa-progress.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
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

describe.skipIf(!RUN)("the open works' import on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const repository = new OpenWorksRepository();
  const importer = new OpenWorksImportService();
  const works = new OpenWorksService();
  const villas = new VillasService();
  const progress = new VillaProgressService();
  const actor: Actor = { id: "admin", role: "ADMIN" };

  beforeAll(async () => {
    scratch = await openScratch("scratch9d", 13);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
        ('con1','Nile','010','ACTIVE',now()), ('con2','Giza','011','ACTIVE',now()), ('con3','Old Co','012','INACTIVE',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","status","updatedAt") VALUES
        ('ph1','Scratch phase',901,'ACTIVE',now()), ('ph2','Second phase',902,'ACTIVE',now()),
        ('ph9','Off phase',909,'INACTIVE',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  let villaCounter = 0;
  async function newVilla(contractorId: string | null = "con1"): Promise<{ id: string; number: string }> {
    villaCounter += 1;
    const id = `villa${villaCounter}`;
    const number = `V-${villaCounter}`;
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
       VALUES ($1,$2,'B1',$3,'eng','admin','area',$4,now())`,
      [id, number, String(villaCounter), contractorId],
    );
    await q(
      `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","version","updatedAt")
       SELECT $1, "id", 0, 1, now() FROM "ElecPhase"`,
      [id],
    );
    return { id, number };
  }

  let fileCounter = 0;
  // A different file every time, so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  // Every row of a race carries this start date, so that the rows of the file can be told from the other writers' items.
  const MARK = "2031-01-01";
  const row = (
    villa: string,
    phase = "Scratch phase",
    contractor: string | null = null,
    start: string | null = null,
  ) => [villa, phase, null, null, null, contractor, start, null];
  const run = async (file: Buffer, dryRun = false) =>
    importer.importFile(actor, { name: "a.xlsx", bytes: file }, dryRun, ctx);
  const countItems = async (villaId: string): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = $1`, [villaId])).rows[0].n;

  const statusOf = (result: PromiseSettledResult<{ status: number }>): number =>
    result.status === "fulfilled"
      ? result.value.status
      : result.reason instanceof AppError
        ? result.reason.statusCode
        : 500;
  function assertNoCrash(results: PromiseSettledResult<unknown>[], label: string): void {
    const crashes = results.flatMap((result) =>
      result.status === "rejected" && !(result.reason instanceof AppError && result.reason.statusCode < 500)
        ? [String((result.reason as Error)?.message ?? result.reason)]
        : [],
    );
    expect(crashes, `${label}: nothing may fail with a database error`).toEqual([]);
  }

  describe("the queries", () => {
    it("reads the villas and the contractors the file is checked against", async () => {
      const villa = await newVilla("con2");

      const found = await repository.importVillas(scratch.prisma as unknown as Prisma.TransactionClient);
      const contractors = await repository.importContractors(
        scratch.prisma as unknown as Prisma.TransactionClient,
      );

      expect(found).toContainEqual({ id: villa.id, villaNumber: villa.number, contractorId: "con2" });
      expect(contractors).toEqual(
        expect.arrayContaining([
          { id: "con1", name: "Nile", phone: "010", status: "ACTIVE" },
          { id: "con3", name: "Old Co", phone: "012", status: "INACTIVE" },
        ]),
      );
    });

    it("reads every electrical phase with its status, for the file to be checked against", async () => {
      const phases = await repository.importElecPhases(scratch.prisma as unknown as Prisma.TransactionClient);

      expect(phases).toEqual(
        expect.arrayContaining([
          { id: "ph1", name: "Scratch phase", status: "ACTIVE" },
          { id: "ph9", name: "Off phase", status: "INACTIVE" },
        ]),
      );
    });

    it("locks the phases shared and answers the status of each; a phase that is gone is missing", async () => {
      const locked = await scratch.prisma.$transaction((tx) =>
        repository.lockElecPhasesShared(["nope", "ph1", "ph9"].sort(), tx),
      );

      expect([...locked.entries()].sort()).toEqual(
        [
          ["ph1", "ACTIVE"],
          ["ph9", "INACTIVE"],
        ].sort(),
      );
      expect(await scratch.prisma.$transaction((tx) => repository.lockElecPhasesShared([], tx))).toEqual(
        new Map(),
      );
    });

    it("locks the villas shared and answers the contractor of each; a villa that is gone is missing", async () => {
      const a = await newVilla("con1");
      const b = await newVilla(null);

      const locked = await scratch.prisma.$transaction((tx) =>
        repository.lockVillasShared([a.id, b.id, "nope"].sort(), tx),
      );

      expect([...locked.entries()].sort()).toEqual(
        [
          [a.id, "con1"],
          [b.id, null],
        ].sort(),
      );
      expect(await scratch.prisma.$transaction((tx) => repository.lockVillasShared([], tx))).toEqual(
        new Map(),
      );
    });

    it("saves the rows as MANUAL items with the maker, and refuses a villa that is not there", async () => {
      const a = await newVilla();
      const new_ = (villaId: string, progress: number) => ({
        villaId,
        elecPhaseId: "ph1",
        status: "IN_PROGRESS" as const,
        priority: "HIGH" as const,
        progress,
        contractorId: null,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: null,
        createdById: "admin",
      });

      const ids = await scratch.prisma.$transaction((tx) =>
        repository.createMany([new_(a.id, 20), new_(a.id, 30)], tx),
      );

      expect(ids).toHaveLength(2);
      expect(
        (await q(`SELECT "id" FROM "WorkItem" WHERE "villaId" = $1`, [a.id])).rows.map((r) => r.id).sort(),
      ).toEqual([...ids].sort());
      const saved = (
        await q(
          `SELECT "source","createdById","elecPhaseId","version","progress" FROM "WorkItem" WHERE "villaId" = $1 ORDER BY "progress"`,
          [a.id],
        )
      ).rows;
      expect(saved).toEqual([
        { source: "MANUAL", createdById: "admin", elecPhaseId: "ph1", version: 1, progress: 20 },
        { source: "MANUAL", createdById: "admin", elecPhaseId: "ph1", version: 1, progress: 30 },
      ]);
      await expect(
        scratch.prisma.$transaction((tx) => repository.createMany([new_("nope", 10)], tx)),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        scratch.prisma.$transaction((tx) =>
          repository.createMany([{ ...new_(a.id, 10), elecPhaseId: "nope" }], tx),
        ),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("lets two imports hold the same villa shared at once, and makes a change of the villa wait for them", async () => {
      const a = await newVilla("con1");
      // The first import holds its lock until the test lets go: nothing here depends on how long anything takes.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const holder = scratch.prisma.$transaction(async (tx) => {
        await repository.lockVillasShared([a.id], tx);
        locked();
        await released;
      });
      await holding;

      // A second shared lock is granted while the first is still held: if it had to wait, this would never return.
      const second = await scratch.prisma.$transaction((tx) => repository.lockVillasShared([a.id], tx));
      expect(second.get(a.id)).toBe("con1");

      // A change of the villa cannot go through while the holder has it. It is still waiting after a while, and it
      // finishes once the holder lets go (a late answer cannot make the first check wrong, only a missing wait can).
      let updated = false;
      const update = villas.update(actor, a.id, { contractorId: "con2" }, ctx).then(() => (updated = true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(updated, "the change of contractor waits for the holder").toBe(false);
      release();
      await holder;
      await update;
      expect(updated).toBe(true);
    }, 60_000);
  });

  describe("the whole import", () => {
    it("saves a file whole: the items, the batch and one audit entry, in one transaction", async () => {
      const a = await newVilla("con1");
      const b = await newVilla(null);
      const file = await fileOf(row(a.number, "Scratch phase", "Nile"), row(b.number, "Second phase"));

      const outcome = await run(file);

      expect(outcome.status).toBe(201);
      expect(outcome.report).toMatchObject({ ok: true, total: 2, imported: 2 });
      const items = (
        await q(
          `SELECT "villaId","elecPhaseId","contractorId","source","createdById" FROM "WorkItem" WHERE "villaId" = ANY($1) ORDER BY "elecPhaseId"`,
          [[a.id, b.id]],
        )
      ).rows;
      expect(items).toEqual([
        { villaId: a.id, elecPhaseId: "ph1", contractorId: "con1", source: "MANUAL", createdById: "admin" },
        { villaId: b.id, elecPhaseId: "ph2", contractorId: null, source: "MANUAL", createdById: "admin" },
      ]);
      expect((await q(`SELECT 1 FROM "AuditLog" WHERE "action" = 'open_work.import'`)).rowCount).toBe(1);
      expect((await q(`SELECT 1 FROM "ImportBatch" WHERE "entity" = 'WorkItem'`)).rowCount).toBe(1);
    });

    it("saves nothing, and records nothing, when a row has a problem or on a dry run", async () => {
      const a = await newVilla("con1");
      const batchesBefore = (await q(`SELECT count(*)::int AS n FROM "ImportBatch"`)).rows[0].n;
      const auditsBefore = (await q(`SELECT count(*)::int AS n FROM "AuditLog"`)).rows[0].n;

      const bad = await run(await fileOf(row(a.number), row("NOPE")));
      const dry = await run(await fileOf(row(a.number)), true);
      const wrongContractor = await run(await fileOf(row(a.number, "Scratch phase", "Giza")));

      expect([bad.status, dry.status, wrongContractor.status]).toEqual([422, 200, 422]);
      expect(await countItems(a.id)).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM "ImportBatch"`)).rows[0].n).toBe(batchesBefore);
      expect((await q(`SELECT count(*)::int AS n FROM "AuditLog"`)).rows[0].n).toBe(auditsBefore);
    });

    it("refuses the same villa and phase twice in the file, and one the villa already has", async () => {
      const a = await newVilla();
      const b = await newVilla();
      await works.create(actor, { villaId: a.id, elecPhaseId: "ph1" }, ctx);

      const twice = await run(await fileOf(row(b.number), row(b.number)));
      const existing = await run(await fileOf(row(a.number)));

      expect(twice).toMatchObject({ status: 422, report: { ok: false } });
      expect(twice.report.errors[0]).toMatchObject({
        row: 3,
        column: "Electrical Phase",
        code: "DUPLICATE_IN_FILE",
      });
      expect(existing.report.errors[0]).toMatchObject({
        row: 2,
        column: "Electrical Phase",
        code: "DUPLICATE_EXISTING",
      });
      expect(await countItems(a.id)).toBe(1);
      expect(await countItems(b.id)).toBe(0);
    });

    it("refuses an unknown phase and an inactive phase, naming the Electrical Phase column", async () => {
      const a = await newVilla();

      const unknown = await run(await fileOf(row(a.number, "No such phase")));
      const inactive = await run(await fileOf(row(a.number, "Off phase")));

      expect(unknown.report.errors[0]).toMatchObject({
        row: 2,
        column: "Electrical Phase",
        code: "REFERENCE_NOT_FOUND",
      });
      expect(inactive.report.errors[0]).toMatchObject({
        row: 2,
        column: "Electrical Phase",
        code: "INVALID_VALUE",
      });
      expect(await countItems(a.id)).toBe(0);
    });

    it("refuses an inactive contractor and another villa's contractor", async () => {
      const a = await newVilla("con3");
      const b = await newVilla("con1");

      const inactive = await run(await fileOf(row(a.number, "Scratch phase", "Old Co")));
      const other = await run(await fileOf(row(b.number, "Scratch phase", "Giza")));

      expect(inactive.report.errors[0]).toMatchObject({ column: "Contractor", code: "INVALID_VALUE" });
      expect(other.report.errors[0]).toMatchObject({ column: "Contractor", code: "CONTRACTOR_NOT_ON_VILLA" });
    });
  });

  describe("at the same time as other writers", () => {
    it("imports and changes of the villa's contractor never deadlock, and a file is saved whole or not at all", async () => {
      for (let round = 1; round <= 25; round += 1) {
        const a = await newVilla("con1");
        const b = await newVilla("con1");
        const file = await fileOf(
          row(a.number, "Scratch phase", "Nile", MARK),
          row(b.number, "Scratch phase", "Nile", MARK),
          row(b.number, "Second phase", null, MARK),
        );
        const batchesBefore = (await q(`SELECT count(*)::int AS n FROM "ImportBatch"`)).rows[0].n;

        const results = await Promise.allSettled([
          run(file),
          villas.update(actor, a.id, { contractorId: "con2" }, ctx),
          villas.update(actor, b.id, { contractorId: round % 2 === 0 ? "con2" : null }, ctx),
          works.create(actor, { villaId: a.id, elecPhaseId: "ph2" }, ctx),
          progress.update(actor, b.id, "ph1", { progress: 30 }, ctx),
        ]);

        assertNoCrash(results, `round ${round}`);
        const status = statusOf(results[0] as PromiseSettledResult<{ status: number }>);
        const saved = (
          await q(
            `SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = ANY($1) AND "startDate" = $2::date`,
            [[a.id, b.id], MARK],
          )
        ).rows[0].n;
        const batches = (await q(`SELECT count(*)::int AS n FROM "ImportBatch"`)).rows[0].n - batchesBefore;
        if (status === 201) {
          expect(saved, `round ${round}: the whole file`).toBe(3);
          expect(batches, `round ${round}: the file is recorded`).toBe(1);
        } else {
          // 409: a contractor changed after the file was checked. 422: it changed before.
          expect([409, 422], `round ${round}: refused on purpose`).toContain(status);
          expect(saved, `round ${round}: nothing of the file`).toBe(0);
          expect(batches, `round ${round}: the file is not recorded`).toBe(0);
        }
      }
    }, 180_000);

    it("an import and a delete of a villa in the file never deadlock, and a file is never half saved", async () => {
      for (let round = 1; round <= 20; round += 1) {
        const a = await newVilla("con1");
        const b = await newVilla("con1");
        const file = await fileOf(row(a.number), row(b.number));

        const results = await Promise.allSettled([run(file), villas.remove(actor, b.id, ctx)]);

        assertNoCrash(results, `round ${round}`);
        const status = statusOf(results[0] as PromiseSettledResult<{ status: number }>);
        const onA = await countItems(a.id);
        if (status === 201) {
          expect(onA, `round ${round}: the villa that stayed has its item`).toBe(1);
        } else {
          // 409: the villa went after the file was checked. 422: it went before.
          expect([409, 422]).toContain(status);
          expect(onA, `round ${round}: nothing was saved`).toBe(0);
        }
        const orphans = (
          await q(
            `SELECT w."id" FROM "WorkItem" w LEFT JOIN "Villa" v ON v."id" = w."villaId" WHERE v."id" IS NULL`,
          )
        ).rows;
        expect(orphans, `round ${round}: no item without a villa`).toEqual([]);
      }
    }, 120_000);

    it("imports of different phases on the same villas all go through, one after the other", async () => {
      const a = await newVilla("con1");
      const b = await newVilla("con1");
      const files = await Promise.all(
        ["Scratch phase", "Second phase"].map((phase) => fileOf(row(a.number, phase), row(b.number, phase))),
      );

      const results = await Promise.allSettled(files.map((file) => run(file)));

      assertNoCrash(results, "parallel imports");
      expect(results.map((result) => statusOf(result as PromiseSettledResult<{ status: number }>))).toEqual([
        201, 201,
      ]);
      expect(await countItems(a.id)).toBe(2);
      expect(await countItems(b.id)).toBe(2);
    }, 60_000);

    it("two different files with the same villa and phase at once: one is saved, the other refused", async () => {
      for (let round = 1; round <= 6; round += 1) {
        const a = await newVilla("con1");
        const files = await Promise.all([
          fileOf(row(a.number, "Scratch phase", null, "2026-01-01")),
          fileOf(row(a.number, "Scratch phase", null, "2026-02-01")),
        ]);

        const results = await Promise.allSettled(files.map((file) => run(file)));

        assertNoCrash(results, `round ${round}`);
        const statuses = results
          .map((result) => statusOf(result as PromiseSettledResult<{ status: number }>))
          .sort();
        expect(statuses[0], `round ${round}`).toBe(201);
        // Checked after the first one was saved (422), or caught by the lock while it was being saved (409).
        expect([409, 422], `round ${round}`).toContain(statuses[1]);
        expect(await countItems(a.id), `round ${round}`).toBe(1);
      }
    }, 60_000);

    it("the same file sent several times at once is saved once", async () => {
      const a = await newVilla("con1");
      const file = await fileOf(row(a.number, "Scratch phase", "Nile"), row(a.number, "Second phase"));

      const results = await Promise.allSettled([run(file), run(file), run(file), run(file)]);

      assertNoCrash(results, "the same file");
      expect(
        results.map((result) => statusOf(result as PromiseSettledResult<{ status: number }>)).sort(),
      ).toEqual([201, 409, 409, 409]);
      expect(await countItems(a.id)).toBe(2);
    }, 60_000);

    it("an import and the switching off of a phase of the file: whole file or nothing, never a half", async () => {
      for (let round = 1; round <= 6; round += 1) {
        const a = await newVilla("con1");
        const phaseId = `race${round}`;
        await q(
          `INSERT INTO "ElecPhase" ("id","name","sortOrder","status","updatedAt") VALUES ($1,$2,$3,'ACTIVE',now())`,
          [phaseId, `Race phase ${round}`, 950 + round],
        );
        const file = await fileOf(
          row(a.number, `Race phase ${round}`, null, MARK),
          row(a.number, "Scratch phase", null, MARK),
        );

        const results = await Promise.allSettled([
          run(file),
          q(`UPDATE "ElecPhase" SET "status" = 'INACTIVE' WHERE "id" = $1`, [phaseId]),
        ]);

        assertNoCrash(results, `import vs switching a phase off, round ${round}`);
        expect([0, 2], `round ${round}: whole file or nothing`).toContain(await countItems(a.id));
      }
    }, 60_000);
  });
});
