import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { PHASE_SET_LOCK } from "../../../shared/constants/locks.js";
import {
  countRowsInProgress,
  deleteRowsAtZero,
  insertRowsForPhase,
} from "../../villa-progress/repository/progress-rows.js";
import { countItemsOfPhase } from "../../open-works/repository/work-item-rows.js";
import { MAX_OPTIONS, type ElecPhaseStatusValue } from "../dto/elec-phases.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  name: true,
  sortOrder: true,
  status: true,
  progressRatio: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ElecPhaseSelect;

export type ElecPhaseRow = Prisma.ElecPhaseGetPayload<{ select: typeof select }>;

type ListParams = { status?: ElecPhaseStatusValue | undefined; skip: number; take: number };

// Display order. `id` breaks ties so pages never repeat or skip rows that share an order.
const ORDER_BY: Prisma.ElecPhaseOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { id: "asc" }];

// One counter per table that points at a phase. A phase with a progress row above 0 is in use; rows still at 0 are
// removed together with the phase. An open work of the phase (made by its progress or typed in) is in use too, at any
// progress: a phase that has one is deactivated, not deleted.
const USAGE_COUNTERS: ((phaseId: string, db: Db) => Promise<number>)[] = [
  countRowsInProgress,
  countItemsOfPhase,
];

export class ElecPhasesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { status, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: ElecPhaseRow[]; total: number }> {
    const where: Prisma.ElecPhaseWhereInput = status ? { status } : {};
    const [rows, total] = await Promise.all([
      db.elecPhase.findMany({ where, select, orderBy: ORDER_BY, skip, take }),
      db.elecPhase.count({ where }),
    ]);
    return { rows, total };
  }

  // The phases a form can offer: the active ones, in display order.
  options(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.elecPhase.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: ORDER_BY,
      take: MAX_OPTIONS,
    });
  }

  findById(id: string, db: Db = prisma): Promise<ElecPhaseRow | null> {
    return db.elecPhase.findUnique({ where: { id }, select });
  }

  // The phase that already has this name, ignoring case: the same comparison as the unique index on lower("name").
  // Raw SQL because Prisma's case-insensitive match is an ILIKE, which would read "_" and "%" in a name as wildcards.
  async findByName(name: string, db: Db = prisma): Promise<{ id: string } | null> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "ElecPhase" WHERE lower("name") = lower(${name}) LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  // Makes adding, reordering and deleting phases (and creating villas, which need a row per phase) take turns, until
  // the transaction ends. Creating a phase reads the highest order and reordering renumbers every row; without this two
  // of them at once would hand out the same numbers. The lock is shared with the villas through PHASE_SET_LOCK.
  async lockOrder(db: Db): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PHASE_SET_LOCK}))`;
  }

  // A progress row at 0 for every villa, for a phase that was just created. Call lockOrder first.
  seedProgressRows(phaseId: string, db: Db): Promise<void> {
    return insertRowsForPhase(phaseId, db);
  }

  // Removes the phase's progress rows that are still at 0, before the phase is deleted.
  deleteZeroProgress(phaseId: string, db: Db): Promise<void> {
    return deleteRowsAtZero(phaseId, db);
  }

  // Adds the phase at the end of the list. Call lockOrder first.
  async create(
    data: { name: string; status: ElecPhaseStatusValue; progressRatio: number },
    db: Db = prisma,
  ): Promise<ElecPhaseRow> {
    const { _max } = await db.elecPhase.aggregate({ _max: { sortOrder: true } });
    return db.elecPhase.create({ data: { ...data, sortOrder: (_max.sortOrder ?? 0) + 1 }, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such phase).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "ElecPhase", id);
  }

  // Locks every phase, in display order, and returns them as they are now.
  async lockAll(db: Db): Promise<ElecPhaseRow[]> {
    await db.$queryRaw`SELECT "id" FROM "ElecPhase" ORDER BY "sortOrder", "id" FOR UPDATE`;
    return db.elecPhase.findMany({ select, orderBy: ORDER_BY });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: { name?: string; status?: ElecPhaseStatusValue; progressRatio?: number },
    db: Db = prisma,
  ): Promise<ElecPhaseRow | null> {
    const { count } = await db.elecPhase.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.elecPhase.findUnique({ where: { id }, select }) : null;
  }

  // The same compare-and-set, for the position alone. Null: the row was not at `version` any more.
  async setSortOrder(
    id: string,
    version: number,
    sortOrder: number,
    db: Db = prisma,
  ): Promise<ElecPhaseRow | null> {
    const { count } = await db.elecPhase.updateMany({
      where: { id, version },
      data: { sortOrder, version: { increment: 1 } },
    });
    return count === 1 ? db.elecPhase.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.elecPhase.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // How many records use this phase, which is what makes a delete refuse: the villa progress rows above 0 and the open
  // works that point at it (each table that points at a phase adds its counter to USAGE_COUNTERS).
  async countUsage(id: string, db: Db): Promise<number> {
    const counts = await Promise.all(USAGE_COUNTERS.map((count) => count(id, db)));
    return counts.reduce((sum, count) => sum + count, 0);
  }
}
