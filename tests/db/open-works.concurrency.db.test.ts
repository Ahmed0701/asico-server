import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// Runs the writers that share a villa's rows AT THE SAME TIME against a real PostgreSQL, in a scratch schema that is
// created for this run and dropped at the end (in a `finally`, so a failure drops it too). No database is created or
// reset, and the asico schema is never touched. It COMMITS inside the scratch schema, which is why it is off unless
// ASICO_DB_TESTS=1. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the lock order (villa, phase, progress rows, items; shared/constants/locks.ts) means the progress
// update, the villa's contractor change, the manual writes and the deletes never deadlock, never make a second
// automatic item for a villa and phase, and leave the items in agreement with the progress rows and the contractor.
const RUN = process.env.ASICO_DB_TESTS === "1";

// The services use the global Prisma client; here it is the one of the scratch schema, set up in beforeAll.
vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import { ElecPhasesService } from "../../src/modules/elec-phases/service/elec-phases.service.js";
import { OpenWorksService } from "../../src/modules/open-works/service/open-works.service.js";
import { VillaProgressService } from "../../src/modules/villa-progress/service/villa-progress.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };

// A tiny deterministic generator, so a failing run can be repeated.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe.skipIf(!RUN)("concurrent writers on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const progress = new VillaProgressService();
  const villas = new VillasService();
  const works = new OpenWorksService();
  const phasesService = new ElecPhasesService();
  const actor: Actor = { id: "admin", role: "ADMIN" };
  const contractors = ["con1", "con2"] as const;
  const phaseIds = ["ph1", "ph2", "ph3", "ph4"];

  beforeAll(async () => {
    scratch = await openScratch("scratch9c", 32);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('con1','Nile','010',now()), ('con2','Giza','011',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    // Four phases of our own (the migrations may have made others, which the villas below get rows for too).
    for (let i = 1; i <= 4; i += 1) {
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ($1,$2,$3,now())`, [
        `ph${i}`,
        `Scratch phase ${i}`,
        900 + i,
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  let villaCounter = 0;
  async function newVilla(contractorId: string | null = "con1"): Promise<string> {
    villaCounter += 1;
    const id = `villa${villaCounter}`;
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
       VALUES ($1,$2,'B1',$3,'eng','admin','area',$4,now())`,
      [id, `V-${villaCounter}`, String(villaCounter), contractorId],
    );
    await q(
      `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","version","updatedAt")
       SELECT $1, "id", 0, 1, now() FROM "ElecPhase"`,
      [id],
    );
    return id;
  }

  // Every outcome must be a success or an error the API answers on purpose (an AppError below 500). Anything else is a
  // deadlock, a serialization failure, a unique violation that should have been absorbed, or a bug.
  function assertNoCrash(results: PromiseSettledResult<unknown>[], label: string): void {
    const crashes = results.flatMap((result) =>
      result.status === "rejected" && !(result.reason instanceof AppError && result.reason.statusCode < 500)
        ? [String((result.reason as Error)?.message ?? result.reason)]
        : [],
    );
    expect(crashes, `${label}: nothing may fail with a database error`).toEqual([]);
  }

  // Every open work is added by hand, and a villa has at most one per electrical phase.
  async function checkVilla(villaId: string, label: string): Promise<void> {
    const items = (await q(`SELECT "elecPhaseId", "source" FROM "WorkItem" WHERE "villaId" = $1`, [villaId]))
      .rows as { elecPhaseId: string; source: string }[];

    expect(
      items.filter((item) => item.source !== "MANUAL"),
      `${label}: no automatic open work`,
    ).toEqual([]);
    const phases = items.map((item) => item.elecPhaseId);
    expect(new Set(phases).size, `${label}: one open work per phase at most`).toBe(phases.length);
  }

  it("progress updates, contractor changes and open work writes of one villa at once never deadlock or duplicate a phase", async () => {
    const random = generator(20_261_103);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

    for (let round = 1; round <= 40; round += 1) {
      const villaId = await newVilla("con1");
      const manual = await works.create(actor, { villaId, elecPhaseId: "ph3" }, ctx);

      const jobs: Promise<unknown>[] = [];
      // Two racing updates for every phase: the first rise of a phase may come from either.
      for (const phaseId of phaseIds) {
        for (let k = 0; k < 2; k += 1) {
          jobs.push(
            progress.update(actor, villaId, phaseId, { progress: 10 + Math.floor(random() * 80) }, ctx),
          );
        }
      }
      // The contractor changes while the progress moves.
      for (let k = 0; k < 4; k += 1) {
        jobs.push(villas.update(actor, villaId, { contractorId: pick([...contractors, null]) }, ctx));
      }
      // Manual items of the same villa are written meanwhile.
      jobs.push(works.create(actor, { villaId, elecPhaseId: "ph1" }, ctx));
      jobs.push(works.update(actor, manual.id, { elecPhaseId: "ph4" }, ctx));
      jobs.push(works.update(actor, manual.id, { priority: "HIGH" }, ctx));

      const results = await Promise.allSettled(jobs);
      assertNoCrash(results, `round ${round}`);
      await checkVilla(villaId, `round ${round}`);
    }
  }, 180_000);

  it("many open works added at once for the same villa and phase make exactly one, and refuse the rest with 409", async () => {
    for (let round = 1; round <= 15; round += 1) {
      const villaId = await newVilla("con2");

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => works.create(actor, { villaId, elecPhaseId: "ph1" }, ctx)),
      );

      assertNoCrash(results, `round ${round}`);
      expect(
        results.filter((result) => result.status === "fulfilled"),
        `round ${round}: one made`,
      ).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason, `round ${round}`).toMatchObject({
            statusCode: 409,
            code: "OPEN_WORK_PHASE_TAKEN",
          });
        }
      }
      await checkVilla(villaId, `round ${round}`);
    }
  }, 120_000);

  it("a phase deleted, deactivated or raised at the same moment never deadlocks, and an item never outlives its phase", async () => {
    for (let round = 1; round <= 20; round += 1) {
      const villaId = await newVilla("con1");
      const phaseId = `race${round}`;
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ($1,$2,$3,now())`, [
        phaseId,
        `Race phase ${round}`,
        1000 + round,
      ]);
      await q(
        `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","version","updatedAt")
         SELECT "id", $1, 0, 1, now() FROM "Villa"
         WHERE NOT EXISTS (SELECT 1 FROM "VillaPhaseProgress" p WHERE p."villaId" = "Villa"."id" AND p."elecPhaseId" = $1)`,
        [phaseId],
      );

      const results = await Promise.allSettled([
        progress.update(actor, villaId, phaseId, { progress: 40 }, ctx),
        phasesService.remove(actor, phaseId, ctx),
        phasesService.update(actor, phaseId, { status: "INACTIVE" }, ctx),
        progress.update(actor, villaId, phaseId, { progress: 60 }, ctx),
        // A manual open work in the phase: the phase cannot be deleted under it, and it cannot be filed under a gone phase.
        works.create(actor, { villaId, elecPhaseId: phaseId }, ctx),
      ]);

      assertNoCrash(results, `round ${round}`);
      const orphans = (
        await q(
          `SELECT w."id" FROM "WorkItem" w LEFT JOIN "ElecPhase" p ON p."id" = w."elecPhaseId" WHERE w."elecPhaseId" IS NOT NULL AND p."id" IS NULL`,
        )
      ).rows;
      expect(orphans, `round ${round}: no item points at a phase that is gone`).toEqual([]);
    }
  }, 120_000);

  it("a villa deleted while its progress and manual items are written never deadlocks", async () => {
    for (let round = 1; round <= 20; round += 1) {
      const villaId = await newVilla("con1");

      const results = await Promise.allSettled([
        villas.remove(actor, villaId, ctx),
        progress.update(actor, villaId, "ph1", { progress: 30 }, ctx),
        progress.update(actor, villaId, "ph2", { progress: 30 }, ctx),
        works.create(actor, { villaId, elecPhaseId: "ph3" }, ctx),
        villas.update(actor, villaId, { contractorId: "con2" }, ctx),
      ]);

      assertNoCrash(results, `round ${round}`);
      const left = (await q(`SELECT count(*)::int AS n FROM "Villa" WHERE "id" = $1`, [villaId])).rows[0].n;
      const items = (await q(`SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = $1`, [villaId]))
        .rows[0].n;
      if (left === 0) expect(items, `round ${round}: a deleted villa has no items`).toBe(0);
    }
  }, 120_000);
});
