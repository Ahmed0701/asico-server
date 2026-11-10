import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import { ElecPhasesRepository } from "../../../src/modules/elec-phases/repository/elec-phases.repository.js";
import {
  countRowsInProgress,
  deleteRowsAtZero,
  insertRowsForPhase,
  insertRowsForVilla,
  insertRowsForVillas,
  lockPhaseSet,
} from "../../../src/modules/villa-progress/repository/progress-rows.js";
import { PHASE_SET_LOCK } from "../../../src/shared/constants/locks.js";

// The real repositories against a recording client: the in-memory fakes replace these, so this is where the wiring
// of the delete guard and the shape of the SQL are checked (the dry run checks what the database does with it).
function recordingDb(count = 0) {
  const sql: { text: string; values: unknown[] }[] = [];
  const record = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first)) {
      // a tagged template: the text between the values, and the values
      sql.push({ text: first.join("?"), values: rest });
    } else {
      const query = first as { sql: string; values: unknown[] };
      sql.push({ text: query.sql, values: query.values });
    }
    return Promise.resolve(0);
  };
  const progress = {
    count: vi.fn(async () => count),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const db = {
    $executeRaw: vi.fn(record),
    villaPhaseProgress: progress,
    workItem: { count: vi.fn(async () => 0) },
  } as unknown as Prisma.TransactionClient;
  return { db, sql, progress };
}

describe("the phase delete guard", () => {
  it("counts a phase's progress rows above 0 as use", async () => {
    const { db, progress } = recordingDb(3);

    expect(await new ElecPhasesRepository().countUsage("phase-1", db)).toBe(3);
    expect(progress.count).toHaveBeenCalledWith({ where: { elecPhaseId: "phase-1", progress: { gt: 0 } } });
  });

  it("finds no use when every row is at 0", async () => {
    const { db } = recordingDb(0);

    expect(await new ElecPhasesRepository().countUsage("phase-1", db)).toBe(0);
  });

  it("counts through the same function the progress module exports", async () => {
    const { db, progress } = recordingDb(2);

    expect(await countRowsInProgress("phase-1", db)).toBe(2);
    expect(progress.count).toHaveBeenCalledTimes(1);
  });
});

describe("the rows at 0", () => {
  it("are removed only where progress is 0, for one phase", async () => {
    const { db, progress } = recordingDb();

    await deleteRowsAtZero("phase-1", db);

    expect(progress.deleteMany).toHaveBeenCalledWith({ where: { elecPhaseId: "phase-1", progress: 0 } });
  });

  it("are inserted for a new villa: one per phase, at 0, version 1, ignoring rows that exist", async () => {
    const { db, sql } = recordingDb();

    await insertRowsForVilla("villa-1", db);

    expect(sql[0]?.text).toContain('INSERT INTO "VillaPhaseProgress"');
    expect(sql[0]?.text).toMatch(/SELECT \?, ph\."id", 0, 1, now\(\) FROM "ElecPhase" ph/);
    expect(sql[0]?.text).toContain("ON CONFLICT DO NOTHING");
    expect(sql[0]?.values).toEqual(["villa-1"]);
  });

  it("are inserted for several new villas in one statement: every phase of each, at 0, version 1, ignoring rows that exist", async () => {
    const { db, sql } = recordingDb();

    await insertRowsForVillas(["villa-1", "villa-2"], db);

    expect(sql).toHaveLength(1);
    expect(sql[0]?.text).toContain('INSERT INTO "VillaPhaseProgress"');
    expect(sql[0]?.text).toContain(
      'SELECT v."id", ph."id", 0, 1, now() FROM "Villa" v CROSS JOIN "ElecPhase" ph',
    );
    expect(sql[0]?.text).toContain('WHERE v."id" = ANY (?::text[])');
    expect(sql[0]?.text).toContain("ON CONFLICT DO NOTHING");
    expect(sql[0]?.values).toEqual([["villa-1", "villa-2"]]);
  });

  it("are not inserted for no villas: no statement at all", async () => {
    const { db, sql } = recordingDb();

    await insertRowsForVillas([], db);

    expect(sql).toHaveLength(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("are inserted for a new phase: one per villa, at 0, version 1, ignoring rows that exist", async () => {
    const { db, sql } = recordingDb();

    await insertRowsForPhase("phase-1", db);

    expect(sql[0]?.text).toMatch(/SELECT v\."id", \?, 0, 1, now\(\) FROM "Villa" v/);
    expect(sql[0]?.text).toContain("ON CONFLICT DO NOTHING");
    expect(sql[0]?.values).toEqual(["phase-1"]);
  });
});

describe("the phase-set lock", () => {
  it("is one advisory lock, taken the same way by the villas and by the phases", async () => {
    const villa = recordingDb();
    const phase = recordingDb();

    await lockPhaseSet(villa.db);
    await new ElecPhasesRepository().lockOrder(phase.db);

    for (const { sql } of [villa, phase]) {
      expect(sql[0]?.text).toContain("pg_advisory_xact_lock(hashtext(");
      expect(sql[0]?.values).toEqual([PHASE_SET_LOCK]);
    }
    expect(PHASE_SET_LOCK).toBe("ElecPhase.order");
  });
});
