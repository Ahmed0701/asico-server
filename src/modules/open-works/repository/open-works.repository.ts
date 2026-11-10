import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import type { ElecPhaseStatusValue } from "../../elec-phases/dto/elec-phases.dto.js";
import type { ImportContractor, ImportVilla } from "../../../shared/import/index.js";
import { escapeLike } from "../../../shared/query/where.js";
import { toDay } from "../../../shared/utils/day.js";
import {
  type OpenWorkFilters,
  type OpenWorkSort,
  type PriorityValue,
  type WorkStatusValue,
} from "../dto/open-works.dto.js";

export type Db = Prisma.TransactionClient;

// A villa has at most one open work per electrical phase: this pair is what makes two of them the same.
export const villaPhaseKey = (villaId: string, elecPhaseId: string): string => `${villaId}:${elecPhaseId}`;

const select = {
  id: true,
  elecPhaseId: true,
  status: true,
  priority: true,
  progress: true,
  contractorId: true,
  startDate: true,
  endDate: true,
  source: true,
  version: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  villa: {
    select: { id: true, villaNumber: true, block: true, plot: true, area: { select: { name: true } } },
  },
  elecPhase: { select: { id: true, name: true } },
  contractor: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemSelect;

export type OpenWorkRow = Prisma.WorkItemGetPayload<{ select: typeof select }>;

export type NewOpenWork = {
  villaId: string;
  elecPhaseId: string;
  status: WorkStatusValue;
  priority: PriorityValue;
  progress: number;
  contractorId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  createdById: string;
};

export type OpenWorkPatch = {
  elecPhaseId?: string;
  status?: WorkStatusValue;
  priority?: PriorityValue;
  progress?: number;
  contractorId?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
};

// What a row of the import file is checked against.
export type { ImportContractor, ImportVilla };
export type ImportElecPhase = { id: string; name: string; status: ElecPhaseStatusValue };

type ListParams = { filters: OpenWorkFilters; sort: OpenWorkSort; today: Date; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a collation or by the villa's location. It returns the ids of
// one page, in order; the rows are then loaded with findMany and put back in that order. The page and the count share
// one WHERE. A pattern is escaped, so `%`, `_` and a backslash in a value match themselves. Enum values are cast, since
// they travel as text.
function conditionsOf(filters: OpenWorkFilters, today: Date): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.villaId) conditions.push(Prisma.sql`w."villaId" = ${filters.villaId}`);
  if (filters.elecPhaseId) conditions.push(Prisma.sql`w."elecPhaseId" = ${filters.elecPhaseId}`);
  if (filters.status) conditions.push(Prisma.sql`w."status" = ${filters.status}::"WorkStatus"`);
  if (filters.priority) conditions.push(Prisma.sql`w."priority" = ${filters.priority}::"Priority"`);
  if (filters.contractorId) conditions.push(Prisma.sql`w."contractorId" = ${filters.contractorId}`);
  if (filters.startFrom) conditions.push(Prisma.sql`w."startDate" >= ${toDay(filters.startFrom)}::date`);
  if (filters.startTo) conditions.push(Prisma.sql`w."startDate" <= ${toDay(filters.startTo)}::date`);
  if (filters.endFrom) conditions.push(Prisma.sql`w."endDate" >= ${toDay(filters.endFrom)}::date`);
  if (filters.endTo) conditions.push(Prisma.sql`w."endDate" <= ${toDay(filters.endTo)}::date`);
  if (filters.overdue !== undefined) {
    const late = Prisma.sql`(w."endDate" < ${toDay(today)}::date AND w."status" <> 'DONE')`;
    conditions.push(filters.overdue ? late : Prisma.sql`NOT COALESCE(${late}, false)`);
  }
  if (filters.done !== undefined) {
    conditions.push(filters.done ? Prisma.sql`w."status" = 'DONE'` : Prisma.sql`w."status" <> 'DONE'`);
  }
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      Prisma.sql`(v."villaNumber" ILIKE ${pattern} OR ep."name" ILIKE ${pattern} OR c."name" ILIKE ${pattern})`,
    );
  }
  return conditions;
}

function whereOf(filters: OpenWorkFilters, today: Date): Prisma.Sql {
  const conditions = conditionsOf(filters, today);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

const FROM = Prisma.sql`FROM "WorkItem" w JOIN "Villa" v ON v."id" = w."villaId" JOIN "Area" a ON a."id" = v."areaId"
  JOIN "ElecPhase" ep ON ep."id" = w."elecPhaseId" LEFT JOIN "Contractor" c ON c."id" = w."contractorId"`;

// `id` breaks ties so pages never repeat or skip rows. Dates that are not set always come last. The text columns use
// the natural collation, so 2 sorts before 10 and A9 before A10. Status and priority follow the order of their
// enums (NOT_STARTED ... DONE, LOW ... HIGH).
function orderBy({ field, direction }: OpenWorkSort): Prisma.Sql {
  const way = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const natural = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`${column} COLLATE "asico_natural" ${way}`;
  switch (field) {
    case "location":
      return Prisma.join(
        [
          natural(Prisma.sql`a."name"`),
          natural(Prisma.sql`a."city"`),
          Prisma.sql`v."areaId" ASC`,
          natural(Prisma.sql`v."block"`),
          natural(Prisma.sql`v."plot"`),
          Prisma.sql`ep."sortOrder" ASC`,
          Prisma.sql`w."id" ASC`,
        ],
        ", ",
      );
    case "elecPhaseName":
      return Prisma.sql`${natural(Prisma.sql`ep."name"`)}, w."id" ASC`;
    case "status":
      return Prisma.sql`w."status" ${way}, w."id" ASC`;
    case "priority":
      return Prisma.sql`w."priority" ${way}, w."id" ASC`;
    case "progress":
      return Prisma.sql`w."progress" ${way}, w."id" ASC`;
    case "startDate":
      return Prisma.sql`w."startDate" ${way} NULLS LAST, w."id" ASC`;
    case "endDate":
      return Prisma.sql`w."endDate" ${way} NULLS LAST, w."id" ASC`;
  }
}

export class OpenWorksRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, today, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: OpenWorkRow[]; total: number }> {
    const where = whereOf(filters, today);
    const [ids, counted] = await Promise.all([
      db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT w."id" ${FROM} ${where} ORDER BY ${orderBy(sort)} LIMIT ${take} OFFSET ${skip}`,
      ),
      db.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT count(*)::int AS "total" ${FROM} ${where}`),
    ]);
    const total = counted[0]?.total ?? 0;
    if (ids.length === 0) {
      return { rows: [], total };
    }
    const loaded = await db.workItem.findMany({ where: { id: { in: ids.map((row) => row.id) } }, select });
    const byId = new Map(loaded.map((row) => [row.id, row]));
    // An item deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  findById(id: string, db: Db = prisma): Promise<OpenWorkRow | null> {
    return db.workItem.findUnique({ where: { id }, select });
  }

  // The villa an item belongs to, read without a lock: the writers take the villa's lock first (see lockVillaShared).
  async findVillaId(id: string, db: Db): Promise<string | null> {
    return (await db.workItem.findUnique({ where: { id }, select: { villaId: true } }))?.villaId ?? null;
  }

  // LOCK ORDER, FIRST: the villa. Everything that writes a villa's open works takes its row before any other lock of
  // this chain (see shared/constants/locks.ts). A reader of the villa's contractor takes it shared, so writers of
  // items take turns with a change of contractor and not with each other. Null: there is no such villa.
  async lockVillaShared(villaId: string, db: Db): Promise<{ contractorId: string | null } | null> {
    const rows = await db.$queryRaw<{ contractorId: string | null }[]>(
      Prisma.sql`SELECT "contractorId" FROM "Villa" WHERE "id" = ${villaId} FOR SHARE`,
    );
    return rows[0] ?? null;
  }

  // LOCK ORDER, LAST: the item. Locks the row until the transaction ends and returns its version (null: no such item).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "WorkItem", id);
  }

  async create(data: NewOpenWork, db: Db = prisma): Promise<OpenWorkRow> {
    return db.workItem.create({ data: { ...data, source: "MANUAL" }, select });
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    patch: OpenWorkPatch,
    db: Db = prisma,
  ): Promise<OpenWorkRow | null> {
    const { count } = await db.workItem.updateMany({
      where: { id, version },
      data: { ...patch, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.workItem.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async contractorStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.contractor.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  // The status of an electrical phase (null: there is no such phase). Read without a lock, like a contractor's status: the
  // foreign key (RESTRICT) has the last word on a phase deleted meanwhile; a phase switched off meanwhile is harmless.
  async elecPhaseStatus(id: string, db: Db = prisma): Promise<ElecPhaseStatusValue | null> {
    return (await db.elecPhase.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  // ---- what the import needs (see ../service/open-works-import.service.ts) ----

  // Every villa, by number, with its contractor: what a row of the file is checked against.
  importVillas(db: Db = prisma): Promise<ImportVilla[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true, contractorId: true } });
  }

  importContractors(db: Db = prisma): Promise<ImportContractor[]> {
    return db.contractor.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  // Every electrical phase, with the status and the name the import's reference rule needs.
  importElecPhases(db: Db = prisma): Promise<ImportElecPhase[]> {
    return db.elecPhase.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  }

  // LOCK ORDER (3): the electrical phases the import writes to, shared and in the order of their ids, after the villas. Returns
  // each one's status as it is now; a phase that is gone is missing.
  async lockElecPhasesShared(
    phaseIds: readonly string[],
    db: Db,
  ): Promise<Map<string, ElecPhaseStatusValue>> {
    if (phaseIds.length === 0) {
      return new Map();
    }
    const rows = await db.$queryRaw<{ id: string; status: ElecPhaseStatusValue }[]>(
      Prisma.sql`SELECT "id", "status"::text AS "status" FROM "ElecPhase" WHERE "id" IN (${Prisma.join([...phaseIds])})
        ORDER BY "id" FOR SHARE`,
    );
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  // LOCK ORDER, FIRST: the villas the import writes to, shared and in the order of their ids, as the other writers of a
  // villa's open works take one. Returns each villa's contractor as it is now; a villa that is gone is missing.
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

  // Saves all the rows as MANUAL items in one statement and returns their ids.
  async createMany(rows: readonly NewOpenWork[], db: Db = prisma): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID(), source: "MANUAL" as const }));
    await db.workItem.createMany({ data });
    return data.map((row) => row.id);
  }

  // ---- one open work per villa and electrical phase ----

  // Makes the writers of one villa's open works under one phase take turns until the transaction ends, so two of them
  // cannot both find the phase free on the villa. Taken after the villa (LOCK ORDER) and only by writers of open works.
  async lockVillaPhase(villaId: string, elecPhaseId: string, db: Db): Promise<void> {
    const key = `open-work:${villaId}:${elecPhaseId}`;
    await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }

  // The villa's open work under this phase (any source), other than `exceptId`. Null: the phase is free on the villa.
  findItemForPhase(
    villaId: string,
    elecPhaseId: string,
    exceptId: string | undefined,
    db: Db,
  ): Promise<{ id: string } | null> {
    return db.workItem.findFirst({
      where: { villaId, elecPhaseId, ...(exceptId !== undefined && { id: { not: exceptId } }) },
      select: { id: true },
    });
  }

  // The "villaId:elecPhaseId" pairs of these villas that already have an open work.
  async takenVillaPhases(villaIds: readonly string[], db: Db = prisma): Promise<Set<string>> {
    if (villaIds.length === 0) {
      return new Set();
    }
    const rows = await db.workItem.findMany({
      where: { villaId: { in: [...villaIds] } },
      select: { villaId: true, elecPhaseId: true },
    });
    return new Set(rows.map((row) => villaPhaseKey(row.villaId, row.elecPhaseId)));
  }
}
