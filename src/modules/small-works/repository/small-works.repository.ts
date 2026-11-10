import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { toDay } from "../../../shared/utils/day.js";
import type { SmallWorkFilters, SmallWorkSort, SmallWorkStatusValue } from "../dto/small-works.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  contractorId: true,
  startDate: true,
  endDate: true,
  description: true,
  status: true,
  version: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  villa: {
    select: { id: true, villaNumber: true, block: true, plot: true, area: { select: { name: true } } },
  },
  contractor: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.DailySmallWorkSelect;

export type SmallWorkRow = Prisma.DailySmallWorkGetPayload<{ select: typeof select }>;

export type NewSmallWork = {
  villaId: string;
  contractorId: string;
  startDate: Date;
  endDate: Date;
  description: string;
  status: SmallWorkStatusValue;
  createdById: string;
};

export type SmallWorkPatch = {
  contractorId?: string;
  startDate?: Date;
  endDate?: Date;
  description?: string;
  status?: SmallWorkStatusValue;
};

// What a row of the import file is checked against: the villas, by number.
export type ImportVillaRef = { id: string; villaNumber: string };
export type ImportContractorRef = { id: string; name: string; phone: string; status: PartyStatusValue };

type ListParams = { filters: SmallWorkFilters; sort: SmallWorkSort; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a collation. It returns the ids of one page, in order; the rows
// are then loaded with findMany and put back in that order. The page and the count share one WHERE. A pattern is
// escaped, so `%`, `_` and a backslash in a value match themselves. The enum travels as text, so it is cast.
function conditionsOf(filters: SmallWorkFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.villaId) conditions.push(Prisma.sql`r."villaId" = ${filters.villaId}`);
  if (filters.status) conditions.push(Prisma.sql`r."status" = ${filters.status}::"SmallWorkStatus"`);
  if (filters.contractorId) conditions.push(Prisma.sql`r."contractorId" = ${filters.contractorId}`);
  if (filters.startFrom) conditions.push(Prisma.sql`r."startDate" >= ${toDay(filters.startFrom)}::date`);
  if (filters.startTo) conditions.push(Prisma.sql`r."startDate" <= ${toDay(filters.startTo)}::date`);
  if (filters.endFrom) conditions.push(Prisma.sql`r."endDate" >= ${toDay(filters.endFrom)}::date`);
  if (filters.endTo) conditions.push(Prisma.sql`r."endDate" <= ${toDay(filters.endTo)}::date`);
  if (filters.alert) {
    // Overdue and due soon are comparisons of endDate with two days of the application's zone (shared/utils/deadline.ts),
    // decided here and not in SQL, so the list, the dashboard, the job and the flags of the DTO cannot disagree.
    const { today, horizon } = filters.alert;
    if (filters.overdue !== undefined) {
      const late = Prisma.sql`(r."status" = 'PENDING' AND r."endDate" < ${today}::date)`;
      conditions.push(filters.overdue ? late : Prisma.sql`NOT ${late}`);
    }
    if (filters.dueSoon !== undefined) {
      const soon = Prisma.sql`(r."status" = 'PENDING' AND r."endDate" >= ${today}::date AND r."endDate" < ${horizon}::date)`;
      conditions.push(filters.dueSoon ? soon : Prisma.sql`NOT ${soon}`);
    }
  }
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      Prisma.sql`(r."description" ILIKE ${pattern} OR c."name" ILIKE ${pattern} OR v."villaNumber" ILIKE ${pattern})`,
    );
  }
  return conditions;
}

function whereOf(filters: SmallWorkFilters): Prisma.Sql {
  const conditions = conditionsOf(filters);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

const FROM = Prisma.sql`FROM "DailySmallWork" r JOIN "Villa" v ON v."id" = r."villaId" JOIN "Contractor" c ON c."id" = r."contractorId"`;

// `id` breaks ties so pages never repeat or skip rows. The villa number uses the natural collation, so V2 sorts before
// V10; the small works of one villa then come by the latest end date first.
function orderBy({ field, direction }: SmallWorkSort): Prisma.Sql {
  const way = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (field) {
    case "startDate":
      return Prisma.sql`r."startDate" ${way}, r."id" ASC`;
    case "endDate":
      return Prisma.sql`r."endDate" ${way}, r."id" ASC`;
    case "villaNumber":
      return Prisma.sql`v."villaNumber" COLLATE "asico_natural" ${way}, r."endDate" DESC, r."id" ASC`;
    case "contractorName":
      return Prisma.sql`c."name" ${way}, r."endDate" DESC, r."id" ASC`;
    case "status":
      return Prisma.sql`r."status" ${way}, r."id" ASC`;
    case "createdAt":
      return Prisma.sql`r."createdAt" ${way}, r."id" ASC`;
  }
}

export class SmallWorksRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: SmallWorkRow[]; total: number }> {
    const where = whereOf(filters);
    const [ids, counted] = await Promise.all([
      db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT r."id" ${FROM} ${where} ORDER BY ${orderBy(sort)} LIMIT ${take} OFFSET ${skip}`,
      ),
      db.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT count(*)::int AS "total" ${FROM} ${where}`),
    ]);
    const total = counted[0]?.total ?? 0;
    if (ids.length === 0) {
      return { rows: [], total };
    }
    const loaded = await db.dailySmallWork.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select,
    });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    // A small work deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  findById(id: string, db: Db = prisma): Promise<SmallWorkRow | null> {
    return db.dailySmallWork.findUnique({ where: { id }, select });
  }

  // The villa a small work belongs to, read without a lock: the writers take the villa's lock first (see lockVillaShared).
  async findVillaId(id: string, db: Db): Promise<string | null> {
    return (
      (await db.dailySmallWork.findUnique({ where: { id }, select: { villaId: true } }))?.villaId ?? null
    );
  }

  // LOCK ORDER, FIRST: the villa. Every writer of a villa's small works takes its row before any other lock of this chain
  // (see shared/constants/locks.ts), shared: writers of small works take turns with a change or a delete of the villa, and
  // not with each other. False: there is no such villa.
  async lockVillaShared(villaId: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId} FOR SHARE`,
    );
    return rows.length > 0;
  }

  // LOCK ORDER, LAST: the small work. Locks the row until the transaction ends and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "DailySmallWork", id);
  }

  create(data: NewSmallWork, db: Db = prisma): Promise<SmallWorkRow> {
    return db.dailySmallWork.create({ data, select });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    patch: SmallWorkPatch,
    db: Db = prisma,
  ): Promise<SmallWorkRow | null> {
    const { count } = await db.dailySmallWork.updateMany({
      where: { id, version },
      data: { ...patch, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.dailySmallWork.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // ---- what the import needs (see ../service/small-works-import.service.ts) ----

  // Every villa, by number: what a row of the file is checked against.
  importVillas(db: Db = prisma): Promise<ImportVillaRef[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true } });
  }

  // The status of a contractor (null: there is no such contractor).
  async contractorStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.contractor.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  // Every contractor, with the status and the phone the import's reference rule needs.
  importContractors(db: Db = prisma): Promise<ImportContractorRef[]> {
    return db.contractor.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  // Whether the acting user still exists: a row is saved with its creator, and a user who is gone cannot be one.
  async userExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.user.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // LOCK ORDER, FIRST: the villas the import writes to, shared and in the order of their ids, as the other writers of a
  // villa's small works take one. Returns the ids that still exist; a villa that is gone is missing.
  async lockVillasShared(villaIds: readonly string[], db: Db): Promise<Set<string>> {
    if (villaIds.length === 0) {
      return new Set();
    }
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" IN (${Prisma.join([...villaIds])}) ORDER BY "id" FOR SHARE`,
    );
    return new Set(rows.map((row) => row.id));
  }

  // The contractors the import writes to, shared and in the order of their ids (after the villas): returns each one's status as
  // it is now; a contractor that is gone is missing.
  async lockContractorsShared(
    contractorIds: readonly string[],
    db: Db,
  ): Promise<Map<string, PartyStatusValue>> {
    if (contractorIds.length === 0) {
      return new Map();
    }
    const rows = await db.$queryRaw<{ id: string; status: PartyStatusValue }[]>(
      Prisma.sql`SELECT "id", "status" FROM "Contractor" WHERE "id" IN (${Prisma.join([...contractorIds])}) ORDER BY "id" FOR SHARE`,
    );
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  // Saves all the rows in one statement and returns their ids.
  async createMany(rows: readonly NewSmallWork[], db: Db = prisma): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID() }));
    await db.dailySmallWork.createMany({ data });
    return data.map((row) => row.id);
  }
}
