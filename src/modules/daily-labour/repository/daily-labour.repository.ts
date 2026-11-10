import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import { toDay } from "../../../shared/utils/day.js";
import type { DailyLabourFilters, DailyLabourSort } from "../dto/daily-labour.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  labourDate: true,
  contractorId: true,
  labourCount: true,
  notes: true,
  version: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  villa: {
    select: { id: true, villaNumber: true, block: true, plot: true, area: { select: { name: true } } },
  },
  contractor: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.DailyLabourSelect;

export type DailyLabourRow = Prisma.DailyLabourGetPayload<{ select: typeof select }>;

export type NewDailyLabour = {
  villaId: string;
  labourDate: Date;
  contractorId: string;
  labourCount: number;
  notes: string | null;
  createdById: string;
};

export type DailyLabourPatch = {
  labourDate?: Date;
  contractorId?: string;
  labourCount?: number;
  notes?: string | null;
};

// What a row of the import file is checked against.
export type ImportVilla = { id: string; villaNumber: string; contractorId: string | null };
export type ImportContractor = { id: string; name: string; phone: string; status: PartyStatusValue };

type ListParams = { filters: DailyLabourFilters; sort: DailyLabourSort; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a collation. It returns the ids of one page, in order; the rows
// are then loaded with findMany and put back in that order. The page and the count share one WHERE. A pattern is
// escaped, so `%`, `_` and a backslash in a value match themselves.
function conditionsOf(filters: DailyLabourFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.villaId) conditions.push(Prisma.sql`r."villaId" = ${filters.villaId}`);
  if (filters.contractorId) conditions.push(Prisma.sql`r."contractorId" = ${filters.contractorId}`);
  if (filters.labourFrom) conditions.push(Prisma.sql`r."labourDate" >= ${toDay(filters.labourFrom)}::date`);
  if (filters.labourTo) conditions.push(Prisma.sql`r."labourDate" <= ${toDay(filters.labourTo)}::date`);
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      Prisma.sql`(v."villaNumber" ILIKE ${pattern} OR c."name" ILIKE ${pattern} OR r."notes" ILIKE ${pattern})`,
    );
  }
  return conditions;
}

function whereOf(filters: DailyLabourFilters): Prisma.Sql {
  const conditions = conditionsOf(filters);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

const FROM = Prisma.sql`FROM "DailyLabour" r JOIN "Villa" v ON v."id" = r."villaId" JOIN "Contractor" c ON c."id" = r."contractorId"`;

// `id` breaks ties so pages never repeat or skip rows. The villa number uses the natural collation, so V2 sorts before
// V10; the rows of one villa then come newest first.
function orderBy({ field, direction }: DailyLabourSort): Prisma.Sql {
  const way = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (field) {
    case "labourDate":
      return Prisma.sql`r."labourDate" ${way}, r."id" ASC`;
    case "villaNumber":
      return Prisma.sql`v."villaNumber" COLLATE "asico_natural" ${way}, r."labourDate" DESC, r."id" ASC`;
    case "contractorName":
      return Prisma.sql`c."name" ${way}, r."labourDate" DESC, r."id" ASC`;
    case "labourCount":
      return Prisma.sql`r."labourCount" ${way}, r."id" ASC`;
    case "createdAt":
      return Prisma.sql`r."createdAt" ${way}, r."id" ASC`;
  }
}

export class DailyLabourRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: DailyLabourRow[]; total: number }> {
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
    const loaded = await db.dailyLabour.findMany({ where: { id: { in: ids.map((row) => row.id) } }, select });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    // A row deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  findById(id: string, db: Db = prisma): Promise<DailyLabourRow | null> {
    return db.dailyLabour.findUnique({ where: { id }, select });
  }

  // The villa a row belongs to, read without a lock: the writers take the villa's lock first (see lockVillaShared).
  async findVillaId(id: string, db: Db): Promise<string | null> {
    return (await db.dailyLabour.findUnique({ where: { id }, select: { villaId: true } }))?.villaId ?? null;
  }

  // LOCK ORDER, FIRST: the villa. Every writer of a villa's daily labour takes its row before any other lock of this
  // chain (see shared/constants/locks.ts), shared: writers of labour rows take turns with a change or a delete of the
  // villa and with a change of its contractor, and not with each other. Null: there is no such villa.
  async lockVillaShared(villaId: string, db: Db): Promise<{ contractorId: string | null } | null> {
    const rows = await db.$queryRaw<{ contractorId: string | null }[]>(
      Prisma.sql`SELECT "contractorId" FROM "Villa" WHERE "id" = ${villaId} FOR SHARE`,
    );
    return rows[0] ?? null;
  }

  // LOCK ORDER, LAST: the row. Locks it until the transaction ends and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "DailyLabour", id);
  }

  create(data: NewDailyLabour, db: Db = prisma): Promise<DailyLabourRow> {
    return db.dailyLabour.create({ data, select });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    patch: DailyLabourPatch,
    db: Db = prisma,
  ): Promise<DailyLabourRow | null> {
    const { count } = await db.dailyLabour.updateMany({
      where: { id, version },
      data: { ...patch, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.dailyLabour.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async contractorStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.contractor.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  // ---- what the import needs (see ../service/daily-labour-import.service.ts) ----

  // Every villa, by number, with its contractor: what a row of the file is checked against.
  importVillas(db: Db = prisma): Promise<ImportVilla[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true, contractorId: true } });
  }

  importContractors(db: Db = prisma): Promise<ImportContractor[]> {
    return db.contractor.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  // The (villa, contractor, day) triples that already have a row, among the given villas.
  existingKeys(
    villaIds: readonly string[],
    db: Db = prisma,
  ): Promise<{ villaId: string; contractorId: string; labourDate: Date }[]> {
    return db.dailyLabour.findMany({
      where: { villaId: { in: [...villaIds] } },
      select: { villaId: true, contractorId: true, labourDate: true },
    });
  }

  // LOCK ORDER, FIRST: the villas the import writes to, shared and in the order of their ids, as the other writers of a
  // villa's labour take one. Returns each villa's contractor as it is now; a villa that is gone is missing.
  async lockVillasShared(villaIds: readonly string[], db: Db): Promise<Map<string, string | null>> {
    if (villaIds.length === 0) {
      return new Map();
    }
    const rows = await db.$queryRaw<{ id: string; contractorId: string | null }[]>(
      Prisma.sql`SELECT "id", "contractorId" FROM "Villa" WHERE "id" IN (${Prisma.join([...villaIds])})
        ORDER BY "id" FOR SHARE`,
    );
    return new Map(rows.map((row) => [row.id, row.contractorId]));
  }

  // Saves all the rows in one statement and returns their ids.
  async createMany(rows: readonly NewDailyLabour[], db: Db = prisma): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID() }));
    await db.dailyLabour.createMany({ data });
    return data.map((row) => row.id);
  }
}
