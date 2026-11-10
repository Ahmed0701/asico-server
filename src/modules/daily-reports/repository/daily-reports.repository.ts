import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import { toDay } from "../../../shared/utils/day.js";
import type { DailyReportFilters, DailyReportSort, WeatherValue } from "../dto/daily-reports.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  reportDate: true,
  weather: true,
  workersCount: true,
  notes: true,
  contractorId: true,
  preparedByEngineerId: true,
  version: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  contractor: { select: { id: true, name: true } },
  preparedByEngineer: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.DailyReportSelect;

export type DailyReportRow = Prisma.DailyReportGetPayload<{ select: typeof select }>;

export type NewDailyReport = {
  contractorId: string;
  preparedByEngineerId: string;
  reportDate: Date;
  weather: WeatherValue;
  workersCount: number;
  notes: string | null;
  createdById: string;
};

export type DailyReportPatch = {
  contractorId?: string;
  preparedByEngineerId?: string;
  reportDate?: Date;
  weather?: WeatherValue;
  workersCount?: number;
  notes?: string | null;
};

// What a row of the import file is checked against: the contractors and the electrical engineers, by name and by phone.
export type ImportParty = { id: string; name: string; phone: string; status: PartyStatusValue };

type ListParams = { filters: DailyReportFilters; sort: DailyReportSort; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a name of a joined row in one statement with the page. It returns the
// ids of one page, in order; the rows are then loaded with findMany and put back in that order. The page and the count share
// one WHERE. A pattern is escaped, so `%`, `_` and a backslash in a value match themselves. The enum travels as text, so it is
// cast. The search looks at the notes only, which the trigram index serves.
function conditionsOf(filters: DailyReportFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.contractorId) conditions.push(Prisma.sql`r."contractorId" = ${filters.contractorId}`);
  if (filters.preparedByEngineerId) {
    conditions.push(Prisma.sql`r."preparedByEngineerId" = ${filters.preparedByEngineerId}`);
  }
  if (filters.weather) conditions.push(Prisma.sql`r."weather" = ${filters.weather}::"Weather"`);
  if (filters.reportFrom) conditions.push(Prisma.sql`r."reportDate" >= ${toDay(filters.reportFrom)}::date`);
  if (filters.reportTo) conditions.push(Prisma.sql`r."reportDate" <= ${toDay(filters.reportTo)}::date`);
  if (filters.search) {
    conditions.push(Prisma.sql`r."notes" ILIKE ${`%${escapeLike(filters.search)}%`}`);
  }
  return conditions;
}

function whereOf(filters: DailyReportFilters): Prisma.Sql {
  const conditions = conditionsOf(filters);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

const JOIN = Prisma.sql`JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId"`;

// One statement, for the page and for the count. Without a search it is the plain join. With a search the matches are found
// first, in a materialized CTE, and only then joined and ordered: left to itself, the planner joins first and loses the
// trigram index (measured in slice 14b: 0.8 to 1.0 s against 1 to 9 ms for 48,000 reports).
function statement(
  filters: DailyReportFilters,
  select: Prisma.Sql,
  tail: Prisma.Sql = Prisma.empty,
): Prisma.Sql {
  const where = whereOf(filters);
  if (!filters.search) {
    return Prisma.sql`SELECT ${select} FROM "DailyReport" r ${JOIN} ${where} ${tail}`;
  }
  return Prisma.sql`WITH r AS MATERIALIZED (SELECT r.* FROM "DailyReport" r ${where}) SELECT ${select} FROM r ${JOIN} ${tail}`;
}

// `id` breaks ties so pages never repeat or skip rows. The names use the natural collation; the reports of one contractor or
// engineer then come newest first.
function orderBy({ field, direction }: DailyReportSort): Prisma.Sql {
  const way = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (field) {
    case "reportDate":
      return Prisma.sql`r."reportDate" ${way}, r."id" ASC`;
    case "contractorName":
      return Prisma.sql`c."name" COLLATE "asico_natural" ${way}, r."reportDate" DESC, r."id" ASC`;
    case "preparedByName":
      return Prisma.sql`e."name" COLLATE "asico_natural" ${way}, r."reportDate" DESC, r."id" ASC`;
    case "weather":
      return Prisma.sql`r."weather" ${way}, r."reportDate" DESC, r."id" ASC`;
    case "createdAt":
      return Prisma.sql`r."createdAt" ${way}, r."id" ASC`;
  }
}

// The rows of a party table, shared and in the order of their ids; the status of each as it is now.
async function lockPartiesShared(
  table: "Contractor" | "ElectricalEngineer",
  ids: readonly string[],
  db: Db,
): Promise<Map<string, PartyStatusValue>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db.$queryRaw<{ id: string; status: PartyStatusValue }[]>(
    Prisma.sql`SELECT "id", "status"::text AS "status" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" IN (${Prisma.join([...ids])}) ORDER BY "id" FOR SHARE`,
  );
  return new Map(rows.map((row) => [row.id, row.status]));
}

export class DailyReportsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: DailyReportRow[]; total: number }> {
    const [ids, counted] = await Promise.all([
      db.$queryRaw<{ id: string }[]>(
        statement(
          filters,
          Prisma.sql`r."id"`,
          Prisma.sql`ORDER BY ${orderBy(sort)} LIMIT ${take} OFFSET ${skip}`,
        ),
      ),
      db.$queryRaw<{ total: number }[]>(statement(filters, Prisma.sql`count(*)::int AS "total"`)),
    ]);
    const total = counted[0]?.total ?? 0;
    if (ids.length === 0) {
      return { rows: [], total };
    }
    const loaded = await db.dailyReport.findMany({ where: { id: { in: ids.map((row) => row.id) } }, select });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    // A report deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  findById(id: string, db: Db = prisma): Promise<DailyReportRow | null> {
    return db.dailyReport.findUnique({ where: { id }, select });
  }

  // LOCK ORDER, LAST: the report. Locks the row until the transaction ends and returns its version (null: no such report).
  // A daily report belongs to no villa, so it is the only lock a writer of a report takes (see shared/constants/locks.ts).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "DailyReport", id);
  }

  create(data: NewDailyReport, db: Db = prisma): Promise<DailyReportRow> {
    return db.dailyReport.create({ data, select });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    patch: DailyReportPatch,
    db: Db = prisma,
  ): Promise<DailyReportRow | null> {
    const { count } = await db.dailyReport.updateMany({
      where: { id, version },
      data: { ...patch, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.dailyReport.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // The status of a contractor or an electrical engineer (null: there is none). Read without a lock, like the small works'
  // contractor: the foreign key (RESTRICT) has the last word on a record deleted meanwhile; one switched off meanwhile is harmless.
  async contractorStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.contractor.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  async engineerStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (
      (await db.electricalEngineer.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    );
  }

  // Whether the acting user still exists: a report is saved with its creator, and a user who is gone cannot be one.
  async userExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.user.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // ---- what the import needs (see ../service/daily-reports-import.service.ts) ----

  importContractors(db: Db = prisma): Promise<ImportParty[]> {
    return db.contractor.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  importEngineers(db: Db = prisma): Promise<ImportParty[]> {
    return db.electricalEngineer.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  // The (contractor, day) pairs that already have a report, among the given contractors.
  existingDays(
    contractorIds: readonly string[],
    db: Db = prisma,
  ): Promise<{ contractorId: string; reportDate: Date }[]> {
    return db.dailyReport.findMany({
      where: { contractorId: { in: [...contractorIds] } },
      select: { contractorId: true, reportDate: true },
    });
  }

  // The contractors / electrical engineers the import writes to, shared and in the order of their ids (contractors first):
  // returns each one's status as it is now; a record that is gone is missing. They take turns with the record's own writes
  // (a switch-off, a delete), and not with each other.
  async lockContractorsShared(ids: readonly string[], db: Db): Promise<Map<string, PartyStatusValue>> {
    return lockPartiesShared("Contractor", ids, db);
  }

  async lockEngineersShared(ids: readonly string[], db: Db): Promise<Map<string, PartyStatusValue>> {
    return lockPartiesShared("ElectricalEngineer", ids, db);
  }

  // Saves all the rows in one statement and returns their ids.
  async createMany(rows: readonly NewDailyReport[], db: Db = prisma): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID() }));
    await db.dailyReport.createMany({ data });
    return data.map((row) => row.id);
  }
}
