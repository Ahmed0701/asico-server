import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import { toDay } from "../../../shared/utils/day.js";
import type { SiteReportFilters, SiteReportSort, SiteReportTypeValue } from "../dto/site-reports.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  visitDate: true,
  title: true,
  inspector: true,
  type: true,
  rating: true,
  findings: true,
  recommendations: true,
  version: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  villa: {
    select: { id: true, villaNumber: true, block: true, plot: true, area: { select: { name: true } } },
  },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.SiteReportSelect;

export type SiteReportRow = Prisma.SiteReportGetPayload<{ select: typeof select }>;

export type NewSiteReport = {
  villaId: string;
  title: string;
  visitDate: Date;
  inspector: string;
  type: SiteReportTypeValue;
  rating: number;
  findings: string;
  recommendations: string | null;
  createdById: string;
};

export type SiteReportPatch = {
  title?: string;
  visitDate?: Date;
  inspector?: string;
  type?: SiteReportTypeValue;
  rating?: number;
  findings?: string;
  recommendations?: string | null;
};

// What a row of the import file is checked against: the villas, by number.
export type ImportVillaRef = { id: string; villaNumber: string };

type ListParams = { filters: SiteReportFilters; sort: SiteReportSort; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a collation. It returns the ids of one page, in order; the rows
// are then loaded with findMany and put back in that order. The page and the count share one WHERE. A pattern is
// escaped, so `%`, `_` and a backslash in a value match themselves. The enum travels as text, so it is cast.
function conditionsOf(filters: SiteReportFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.villaId) conditions.push(Prisma.sql`r."villaId" = ${filters.villaId}`);
  if (filters.type) conditions.push(Prisma.sql`r."type" = ${filters.type}::"SiteReportType"`);
  if (filters.rating !== undefined) conditions.push(Prisma.sql`r."rating" = ${filters.rating}`);
  if (filters.visitFrom) conditions.push(Prisma.sql`r."visitDate" >= ${toDay(filters.visitFrom)}::date`);
  if (filters.visitTo) conditions.push(Prisma.sql`r."visitDate" <= ${toDay(filters.visitTo)}::date`);
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      Prisma.sql`(r."title" ILIKE ${pattern} OR r."inspector" ILIKE ${pattern} OR v."villaNumber" ILIKE ${pattern})`,
    );
  }
  return conditions;
}

function whereOf(filters: SiteReportFilters): Prisma.Sql {
  const conditions = conditionsOf(filters);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

const FROM = Prisma.sql`FROM "SiteReport" r JOIN "Villa" v ON v."id" = r."villaId"`;

// `id` breaks ties so pages never repeat or skip rows. The villa number uses the natural collation, so V2 sorts before
// V10; the site reports of one villa then come newest first.
function orderBy({ field, direction }: SiteReportSort): Prisma.Sql {
  const way = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (field) {
    case "visitDate":
      return Prisma.sql`r."visitDate" ${way}, r."id" ASC`;
    case "villaNumber":
      return Prisma.sql`v."villaNumber" COLLATE "asico_natural" ${way}, r."visitDate" DESC, r."id" ASC`;
    case "rating":
      return Prisma.sql`r."rating" ${way}, r."id" ASC`;
    case "type":
      return Prisma.sql`r."type" ${way}, r."id" ASC`;
    case "createdAt":
      return Prisma.sql`r."createdAt" ${way}, r."id" ASC`;
  }
}

export class SiteReportsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: SiteReportRow[]; total: number }> {
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
    const loaded = await db.siteReport.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select,
    });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    // A site report deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  findById(id: string, db: Db = prisma): Promise<SiteReportRow | null> {
    return db.siteReport.findUnique({ where: { id }, select });
  }

  // The villa a site report belongs to, read without a lock: the writers take the villa's lock first (see lockVillaShared).
  async findVillaId(id: string, db: Db): Promise<string | null> {
    return (await db.siteReport.findUnique({ where: { id }, select: { villaId: true } }))?.villaId ?? null;
  }

  // LOCK ORDER, FIRST: the villa. Every writer of a villa's site reports takes its row before any other lock of this chain
  // (see shared/constants/locks.ts), shared: writers of site reports take turns with a change or a delete of the villa, and
  // not with each other. False: there is no such villa.
  async lockVillaShared(villaId: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId} FOR SHARE`,
    );
    return rows.length > 0;
  }

  // LOCK ORDER, LAST: the site report. Locks the row until the transaction ends and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "SiteReport", id);
  }

  create(data: NewSiteReport, db: Db = prisma): Promise<SiteReportRow> {
    return db.siteReport.create({ data, select });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    patch: SiteReportPatch,
    db: Db = prisma,
  ): Promise<SiteReportRow | null> {
    const { count } = await db.siteReport.updateMany({
      where: { id, version },
      data: { ...patch, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.siteReport.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // ---- what the import needs (see ../service/site-reports-import.service.ts) ----

  // Every villa, by number: what a row of the file is checked against.
  importVillas(db: Db = prisma): Promise<ImportVillaRef[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true } });
  }

  // Whether the acting user still exists: a row is saved with its creator, and a user who is gone cannot be one.
  async userExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.user.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // LOCK ORDER, FIRST: the villas the import writes to, shared and in the order of their ids, as the other writers of a
  // villa's site reports take one. Returns the ids that still exist; a villa that is gone is missing.
  async lockVillasShared(villaIds: readonly string[], db: Db): Promise<Set<string>> {
    if (villaIds.length === 0) {
      return new Set();
    }
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" IN (${Prisma.join([...villaIds])}) ORDER BY "id" FOR SHARE`,
    );
    return new Set(rows.map((row) => row.id));
  }

  // Saves all the rows in one statement and returns their ids.
  async createMany(rows: readonly NewSiteReport[], db: Db = prisma): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID() }));
    await db.siteReport.createMany({ data });
    return data.map((row) => row.id);
  }
}
