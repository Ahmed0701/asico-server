import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// Who last set the progress of a villa's open work under a phase, and when, on a real PostgreSQL (scratch schema): set on
// create, kept by an edit that does not touch the progress, moved to the editor by one that does, and read back by the
// villa detail beside the phase.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import { OpenWorksService } from "../../src/modules/open-works/service/open-works.service.js";
import { toDetailDto } from "../../src/modules/villas/mapper/villas.mapper.js";
import { VillasRepository } from "../../src/modules/villas/repository/villas.repository.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const mona = { id: "mona", role: "ADMIN" } as never;
const omar = { id: "omar", role: "EMPLOYEE" } as never;

describe.skipIf(!RUN)("the latest progress change of a phase (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  beforeAll(async () => {
    scratch = await openScratch("scratchprogchange", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('mona','Mona Admin','m@x.test','x','ADMIN',true,now()), ('omar','Omar Employee','o@x.test','x','EMPLOYEE',true,now())`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Area','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
       ('v1','V-1','B1','1','eng','mona','area',now())`,
    );
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES
       ('00000000-0000-4000-8000-000000000001','Change phase A',901,now()),
       ('00000000-0000-4000-8000-000000000002','Change phase B',902,now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  const phaseA = "00000000-0000-4000-8000-000000000001";
  const phaseB = "00000000-0000-4000-8000-000000000002";
  const detailPhase = async (phaseId: string) => {
    const row = await new VillasRepository().findDetail("v1");
    return toDetailDto(row!).phases.find((phase) => phase.elecPhaseId === phaseId)!;
  };

  it("records who set the progress and when, and the villa detail shows it beside the phase", async () => {
    const service = new OpenWorksService(new OpenWorksRepository());
    expect((await detailPhase(phaseA)).lastChange).toBeNull();

    const created = await service.create(
      mona,
      { villaId: "v1", elecPhaseId: phaseA, progress: 20 } as never,
      ctx,
    );
    const afterCreate = await detailPhase(phaseA);
    expect(afterCreate.lastChange?.by).toEqual({ id: "mona", name: "Mona Admin" });
    expect(Date.parse(afterCreate.lastChange!.at)).not.toBeNaN();

    // An edit that leaves the progress alone keeps who and when.
    const kept = await service.update(omar, created.id, { priority: "HIGH" } as never, ctx, created.version);
    expect((await detailPhase(phaseA)).lastChange).toEqual(afterCreate.lastChange);

    // A new progress moves it to the editor.
    const moved = await service.update(omar, created.id, { progress: 60 } as never, ctx, kept.version);
    const afterEdit = await detailPhase(phaseA);
    expect(afterEdit.lastChange?.by).toEqual({ id: "omar", name: "Omar Employee" });
    expect(Date.parse(afterEdit.lastChange!.at)).toBeGreaterThanOrEqual(
      Date.parse(afterCreate.lastChange!.at),
    );

    // Moving the work to another phase counts as a change there; the old phase has no open work any more.
    await service.update(mona, created.id, { elecPhaseId: phaseB } as never, ctx, moved.version);
    expect((await detailPhase(phaseA)).lastChange).toBeNull();
    expect((await detailPhase(phaseB)).lastChange?.by).toEqual({ id: "mona", name: "Mona Admin" });

    // A deleted user leaves the time, without a name.
    await q(`UPDATE "Villa" SET "createdById" = 'omar' WHERE "id" = 'v1'`);
    await q(`DELETE FROM "User" WHERE "id" = 'mona'`);
    const gone = await detailPhase(phaseB);
    expect(gone.lastChange?.by).toBeNull();
    expect(gone.lastChange?.at).toBeTruthy();
  });
});
