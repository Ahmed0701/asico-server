import type { MewStateValue } from "../../../shared/constants/enums.js";
import { randomUUID } from "node:crypto";
import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue, VillaTypeValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import { toDay } from "../../../shared/utils/day.js";
import {
  insertRowsForVilla,
  insertRowsForVillas,
  lockPhaseSet,
  PHASE_DONE_RATIO,
} from "../../villa-progress/repository/progress-rows.js";
import { doneRatioOf, phaseProgressOf } from "../../villa-progress/dto/villa-progress.dto.js";
import {
  MAX_FILTER_VALUES,
  MAX_OPTIONS,
  type VillaFilters,
  type VillaFiltersDto,
  type VillaSort,
} from "../dto/villas.dto.js";

export type Db = Prisma.TransactionClient;

const scalars = {
  id: true,
  villaNumber: true,
  ownerName: true,
  villaType: true,
  areaId: true,
  area: { select: { name: true } },
  block: true,
  plot: true,
  startDate: true,
  targetDate: true,
  budgetMinor: true,
  currency: true,
  mewFollowUpAt: true,
  mewFollowUpBy: { select: { id: true, name: true } },
  mewInspectionAt: true,
  mewInspectionBy: { select: { id: true, name: true } },
  mewInspectionPassedAt: true,
  mewInspectionPassedBy: { select: { id: true, name: true } },
  mewAcState: true,
  mewElecState: true,
  mewInspectionDate: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const listSelect = {
  ...scalars,
  civilEngineer: { select: { id: true, name: true } },
  electricalEngineer: { select: { id: true, name: true } },
  contractor: { select: { id: true, name: true } },
} satisfies Prisma.VillaSelect;

const detailSelect = {
  ...scalars,
  civilEngineer: { select: { id: true, name: true, phone: true } },
  electricalEngineer: { select: { id: true, name: true, phone: true } },
  contractor: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.VillaSelect;

// What an audit entry and the update logic need to know about a villa as it is now.
const snapshotSelect = {
  villaNumber: true,
  ownerName: true,
  villaType: true,
  areaId: true,
  block: true,
  plot: true,
  civilEngineerId: true,
  electricalEngineerId: true,
  contractorId: true,
  startDate: true,
  targetDate: true,
  budgetMinor: true,
  currency: true,
} satisfies Prisma.VillaSelect;

// The progress is derived on read: `doneRatio` is what the villa's done active phases add up to (PHASE_DONE_RATIO), and
// `phaseCount` how many active phases there are.
export type ProgressTotals = { doneRatio: number; phaseCount: number };

// An active phase with the villa's progress in it (a row that is missing reads as 0, version 1).
export type VillaPhaseRow = {
  elecPhaseId: string;
  name: string;
  sortOrder: number;
  progressRatio: number;
  progress: number;
  version: number;
};

export type VillaListRow = Prisma.VillaGetPayload<{ select: typeof listSelect }> & ProgressTotals;
export type VillaDetailRow = Prisma.VillaGetPayload<{ select: typeof detailSelect }> &
  ProgressTotals & { phases: VillaPhaseRow[] };
export type VillaSnapshotRow = Prisma.VillaGetPayload<{ select: typeof snapshotSelect }>;

// The mark a villa is given (when, and by whom), or null to clear it.
export type InspectionMark = { at: Date; byId: string } | null;

// The marks a person puts on a villa and takes off again, each a time and a user: the MEW follow-up list and the MEW
// inspection list, and the MEW inspection passed list.
export const VILLA_MARKS = ["mewFollowUp", "mewInspection", "mewInspectionPassed"] as const;
export type VillaMark = (typeof VILLA_MARKS)[number];
// One of those marks as stored: when, and by whom (the user can be gone while the time stays). Set with InspectionMark.
export type MarkRow = { at: Date | null; byId: string | null };
// The villa's MEW details that a request changes: the two states and the inspection day (null clears it).
export type MewStatesPatch = {
  mewAcState?: MewStateValue | undefined;
  mewElecState?: MewStateValue | undefined;
  mewInspectionDate?: Date | null | undefined;
};
// The same details as stored.
export type MewStatesRow = {
  mewAcState: MewStateValue;
  mewElecState: MewStateValue;
  mewInspectionDate: Date | null;
};

export type NewVilla = {
  villaNumber: string;
  ownerName: string | null;
  villaType: VillaTypeValue | null;
  areaId: string;
  block: string;
  plot: string;
  civilEngineerId: string;
  electricalEngineerId: string | null;
  contractorId: string | null;
  createdById: string;
  startDate: Date | null;
  targetDate: Date | null;
  // Minor units. The column is a BIGINT; the API's cap (2^53 - 1) keeps the number exact.
  budgetMinor: number | null;
  currency: string | null;
};

// A villa the import makes: a new villa plus the id it is given up front, so the progress rows and the audit entries can name it.
export type ImportedVilla = NewVilla & { id: string };

// The parties and the area a villa of the file points to, with the statuses they have at the moment they are locked.
export type ImportRefs = {
  areaIds: readonly string[];
  civilEngineerIds: readonly string[];
  electricalEngineerIds: readonly string[];
  contractorIds: readonly string[];
};
export type LockedRefs = {
  areas: ReadonlySet<string>;
  civilEngineers: ReadonlyMap<string, PartyStatusValue>;
  electricalEngineers: ReadonlyMap<string, PartyStatusValue>;
  contractors: ReadonlyMap<string, PartyStatusValue>;
};

export type VillaPatch = {
  villaNumber?: string;
  ownerName?: string | null;
  villaType?: VillaTypeValue | null;
  areaId?: string;
  block?: string;
  plot?: string;
  civilEngineerId?: string;
  electricalEngineerId?: string | null;
  contractorId?: string | null;
  startDate?: Date | null;
  targetDate?: Date | null;
  budgetMinor?: number | null;
  currency?: string | null;
};

type ListParams = { filters: VillaFilters; sort: VillaSort; skip: number; take: number };

// The list is a raw query, because Prisma cannot order by a collation. It returns the ids of one page, in order;
// the rows are then loaded with findMany and put back in that order. The page and the count share one WHERE.
// A pattern is escaped, so `%`, `_` and a backslash in a value match themselves.
function conditionsOf(filters: VillaFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.areaId) conditions.push(Prisma.sql`v."areaId" = ${filters.areaId}`);
  if (filters.area) conditions.push(Prisma.sql`a."name" ILIKE ${escapeLike(filters.area)}`);
  if (filters.block) conditions.push(Prisma.sql`v."block" ILIKE ${escapeLike(filters.block)}`);
  if (filters.plot) conditions.push(Prisma.sql`v."plot" ILIKE ${escapeLike(filters.plot)}`);
  if (filters.civilEngineerId) conditions.push(Prisma.sql`v."civilEngineerId" = ${filters.civilEngineerId}`);
  if (filters.electricalEngineerId) {
    conditions.push(Prisma.sql`v."electricalEngineerId" = ${filters.electricalEngineerId}`);
  }
  if (filters.contractorId) conditions.push(Prisma.sql`v."contractorId" = ${filters.contractorId}`);
  if (filters.villaType) conditions.push(Prisma.sql`v."villaType" = ${filters.villaType}::"VillaType"`);
  if (filters.mewInspectionPassed !== undefined) {
    conditions.push(
      filters.mewInspectionPassed
        ? Prisma.sql`v."mewInspectionPassedAt" IS NOT NULL`
        : Prisma.sql`v."mewInspectionPassedAt" IS NULL`,
    );
  }
  if (filters.mewInspection !== undefined) {
    conditions.push(
      filters.mewInspection
        ? Prisma.sql`v."mewInspectionAt" IS NOT NULL`
        : Prisma.sql`v."mewInspectionAt" IS NULL`,
    );
  }
  if (filters.mewFollowUp !== undefined) {
    conditions.push(
      filters.mewFollowUp ? Prisma.sql`v."mewFollowUpAt" IS NOT NULL` : Prisma.sql`v."mewFollowUpAt" IS NULL`,
    );
  }
  if (filters.startFrom) conditions.push(Prisma.sql`v."startDate" >= ${toDay(filters.startFrom)}::date`);
  if (filters.startTo) conditions.push(Prisma.sql`v."startDate" <= ${toDay(filters.startTo)}::date`);
  if (filters.targetFrom) conditions.push(Prisma.sql`v."targetDate" >= ${toDay(filters.targetFrom)}::date`);
  if (filters.targetTo) conditions.push(Prisma.sql`v."targetDate" <= ${toDay(filters.targetTo)}::date`);
  if (filters.search) {
    // Exactly four places, each served by a trigram index.
    const like = `%${escapeLike(filters.search)}%`;
    conditions.push(Prisma.sql`(
      v."villaNumber" ILIKE ${like}
      OR v."ownerName" ILIKE ${like}
      OR v."civilEngineerId" IN (SELECT ce."id" FROM "CivilEngineer" ce WHERE ce."name" ILIKE ${like})
      OR v."electricalEngineerId" IN (SELECT ee."id" FROM "ElectricalEngineer" ee WHERE ee."name" ILIKE ${like})
    )`);
  }
  return conditions;
}

function whereOf(filters: VillaFilters): Prisma.Sql {
  const conditions = conditionsOf(filters);
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
}

// `id` breaks ties so pages never repeat or skip rows. Villas without a target date always come last. The text
// columns use the natural collation, so 2 sorts before 10 and A9 before A10.
function orderBy({ field, direction }: VillaSort): Prisma.Sql {
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
          Prisma.sql`v."id" ASC`,
        ],
        ", ",
      );
    case "villaNumber":
      return Prisma.sql`${natural(Prisma.sql`v."villaNumber"`)}, v."id" ASC`;
    case "progress":
      return Prisma.sql`pr."average" ${way}, v."id" ASC`;
    case "targetDate":
      return Prisma.sql`v."targetDate" ${way} NULLS LAST, v."id" ASC`;
    case "createdAt":
      return Prisma.sql`v."createdAt" ${way}, v."id" ASC`;
  }
}

// Sorting by progress joins each villa to the weighted average of its active phases, unrounded (a villa with no active
// phases is at 0). A phase's progress is read from the villa's open works (PHASE_PROGRESS). Only that sort pays for the join.
function joinsOf({ field }: VillaSort): Prisma.Sql {
  return field === "progress"
    ? Prisma.sql`LEFT JOIN LATERAL (
        SELECT LEAST(100, COALESCE(sum(${PHASE_DONE_RATIO}), 0)) AS "average"
        FROM "ElecPhase" ph
        WHERE ph."status" = 'ACTIVE'
      ) pr ON true`
    : Prisma.empty;
}

const totalsOf = (totals: Map<string, ProgressTotals>, id: string): ProgressTotals =>
  totals.get(id) ?? { doneRatio: 0, phaseCount: 0 };

// The same totals, from phases already loaded (the detail).
function totalsOfPhases(phases: readonly VillaPhaseRow[]): ProgressTotals {
  return {
    doneRatio: phases.reduce((sum, phase) => sum + doneRatioOf(phase), 0),
    phaseCount: phases.length,
  };
}

// The two columns of each MEW mark, read together.
const MARK_SELECT = {
  mewFollowUpAt: true,
  mewFollowUpById: true,
  mewInspectionAt: true,
  mewInspectionById: true,
  mewInspectionPassedAt: true,
  mewInspectionPassedById: true,
} satisfies Prisma.VillaSelect;

// What writing a mark (or clearing it, with null) sets: its time and its user.
function markColumns(mark: VillaMark, value: InspectionMark): Prisma.VillaUncheckedUpdateManyInput {
  const at = value?.at ?? null;
  const byId = value?.byId ?? null;
  switch (mark) {
    case "mewFollowUp":
      return { mewFollowUpAt: at, mewFollowUpById: byId };
    case "mewInspection":
      return { mewInspectionAt: at, mewInspectionById: byId };
    case "mewInspectionPassed":
      return { mewInspectionPassedAt: at, mewInspectionPassedById: byId };
  }
}

const toBigInt = (value: number | null): bigint | null => (value === null ? null : BigInt(value));

export class VillasRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: VillaListRow[]; total: number }> {
    const where = whereOf(filters);
    const [ids, counted] = await Promise.all([
      db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT v."id" FROM "Villa" v JOIN "Area" a ON a."id" = v."areaId" ${joinsOf(sort)} ${where} ORDER BY ${orderBy(sort)} LIMIT ${take} OFFSET ${skip}`,
      ),
      db.$queryRaw<{ total: number }[]>(
        Prisma.sql`SELECT count(*)::int AS "total" FROM "Villa" v JOIN "Area" a ON a."id" = v."areaId" ${where}`,
      ),
    ]);
    const total = counted[0]?.total ?? 0;
    if (ids.length === 0) {
      return { rows: [], total };
    }
    const loaded = await db.villa.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select: listSelect,
    });
    const totals = await this.progressTotals(
      loaded.map((row) => row.id),
      db,
    );
    const byId = new Map(loaded.map((row) => [row.id, { ...row, ...totalsOf(totals, row.id) }]));
    // A villa deleted between the two queries is simply missing from the page.
    return { rows: ids.flatMap(({ id }) => byId.get(id) ?? []), total };
  }

  // The sum and the count behind each villa's overall progress. A villa that is not in the answer has no active phase
  // to count (the count is the same for every villa), so it reads as 0 of 0.
  async progressTotals(villaIds: string[], db: Db = prisma): Promise<Map<string, ProgressTotals>> {
    if (villaIds.length === 0) {
      return new Map();
    }
    const rows = await db.$queryRaw<({ id: string } & ProgressTotals)[]>(
      Prisma.sql`SELECT v."id",
          COALESCE(sum(${PHASE_DONE_RATIO}), 0)::int AS "doneRatio",
          count(ph."id")::int AS "phaseCount"
        FROM "Villa" v
        CROSS JOIN "ElecPhase" ph
        WHERE ph."status" = 'ACTIVE' AND v."id" IN (${Prisma.join(villaIds)})
        GROUP BY v."id"`,
    );
    return new Map(rows.map((row) => [row.id, { doneRatio: row.doneRatio, phaseCount: row.phaseCount }]));
  }

  options(db: Db = prisma): Promise<{ id: string; villaNumber: string }[]> {
    return db.villa.findMany({
      select: { id: true, villaNumber: true },
      orderBy: [{ villaNumber: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  // Values for the filter dropdowns. GROUP BY runs in the database; the cap keeps the payload bounded.
  // An area is listed by name, once, even when two cities have an area of that name.
  // The engineers are the ones that have at least one villa, active or not, so a villa is always findable by its engineer.
  async filterOptions(db: Db = prisma): Promise<VillaFiltersDto> {
    const [areas, blocks, civilEngineers, electricalEngineers] = await Promise.all([
      db.area.findMany({
        where: { villas: { some: {} } },
        select: { name: true },
        distinct: ["name"],
        orderBy: { name: "asc" },
        take: MAX_FILTER_VALUES,
      }),
      db.villa.groupBy({ by: ["block"], orderBy: { block: "asc" }, take: MAX_FILTER_VALUES }),
      db.civilEngineer.findMany({
        where: { villas: { some: {} } },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: MAX_FILTER_VALUES,
      }),
      db.electricalEngineer.findMany({
        where: { villas: { some: {} } },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: MAX_FILTER_VALUES,
      }),
    ]);
    return {
      areas: areas.map((row) => row.name),
      blocks: blocks.map((row) => row.block),
      civilEngineers,
      electricalEngineers,
    };
  }

  async findDetail(id: string, db: Db = prisma): Promise<VillaDetailRow | null> {
    const row = await db.villa.findUnique({ where: { id }, select: detailSelect });
    if (!row) {
      return null;
    }
    const active = await db.elecPhase.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        sortOrder: true,
        progressRatio: true,
        villaProgress: { where: { villaId: id }, select: { progress: true, version: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    // A phase's progress is read from the villa's open works filed under it (phaseProgressOf, the twin of PHASE_PROGRESS).
    const openWorks = await db.workItem.findMany({
      where: { villaId: id },
      select: { elecPhaseId: true, progress: true },
    });
    const phases = active.map((phase): VillaPhaseRow => ({
      elecPhaseId: phase.id,
      name: phase.name,
      sortOrder: phase.sortOrder,
      progressRatio: phase.progressRatio,
      progress: phaseProgressOf(
        openWorks.filter((work) => work.elecPhaseId === phase.id).map((work) => work.progress),
      ),
      // The version of the phase's progress row (the PATCH endpoint's If-Match); 1 when the row is missing.
      version: phase.villaProgress[0]?.version ?? 1,
    }));
    return {
      ...row,
      phases,
      ...totalsOfPhases(phases),
    };
  }

  async findListRow(id: string, db: Db = prisma): Promise<VillaListRow | null> {
    const row = await db.villa.findUnique({ where: { id }, select: listSelect });
    return row && { ...row, ...totalsOf(await this.progressTotals([id], db), id) };
  }

  // Makes creating a villa and creating or deleting a phase take turns (see PHASE_SET_LOCK), until the transaction ends.
  lockPhaseSet(db: Db): Promise<void> {
    return lockPhaseSet(db);
  }

  // A row at 0 for every phase, for a villa that was just created. Call lockPhaseSet first.
  insertProgressRows(villaId: string, db: Db): Promise<void> {
    return insertRowsForVilla(villaId, db);
  }

  findSnapshot(id: string, db: Db = prisma): Promise<VillaSnapshotRow | null> {
    return db.villa.findUnique({ where: { id }, select: snapshotSelect });
  }

  async findMark(id: string, mark: VillaMark, db: Db): Promise<MarkRow | null> {
    const row = await db.villa.findUnique({ where: { id }, select: MARK_SELECT });
    if (!row) {
      return null;
    }
    switch (mark) {
      case "mewFollowUp":
        return { at: row.mewFollowUpAt, byId: row.mewFollowUpById };
      case "mewInspection":
        return { at: row.mewInspectionAt, byId: row.mewInspectionById };
      case "mewInspectionPassed":
        return { at: row.mewInspectionPassedAt, byId: row.mewInspectionPassedById };
    }
  }

  // Compare-and-set, like updateScalars: puts the mark on (or takes it off) only if the villa is still at `version`.
  async setMark(
    id: string,
    version: number,
    mark: VillaMark,
    value: InspectionMark,
    db: Db,
  ): Promise<boolean> {
    const { count } = await db.villa.updateMany({
      where: { id, version },
      data: { ...markColumns(mark, value), version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1;
  }

  findMewStates(id: string, db: Db): Promise<MewStatesRow | null> {
    return db.villa.findUnique({
      where: { id },
      select: { mewAcState: true, mewElecState: true, mewInspectionDate: true },
    });
  }

  // The same compare-and-set, for the villa's MEW states.
  async setMewStates(id: string, version: number, states: MewStatesPatch, db: Db): Promise<boolean> {
    const { count } = await db.villa.updateMany({
      where: { id, version },
      data: {
        ...(states.mewAcState !== undefined && { mewAcState: states.mewAcState }),
        ...(states.mewElecState !== undefined && { mewElecState: states.mewElecState }),
        ...(states.mewInspectionDate !== undefined && { mewInspectionDate: states.mewInspectionDate }),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  async areaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.area.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // The status of a party, or null when there is no such record.
  async civilEngineerStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.civilEngineer.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  async electricalEngineerStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (
      (await db.electricalEngineer.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    );
  }

  async contractorStatus(id: string, db: Db = prisma): Promise<PartyStatusValue | null> {
    return (await db.contractor.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  }

  async create(data: NewVilla, db: Db = prisma): Promise<VillaListRow> {
    const row = await db.villa.create({
      data: { ...data, budgetMinor: toBigInt(data.budgetMinor) },
      select: listSelect,
    });
    // A new villa is at 0 in every phase.
    const phaseCount = await db.elecPhase.count({ where: { status: "ACTIVE" } });
    return { ...row, doneRatio: 0, phaseCount };
  }

  // What the import checks the file against: every area, and every party with its status (all of them, active or not: the
  // import answers "inactive" for a switched-off one rather than "not found").
  importAreas(db: Db = prisma): Promise<{ id: string; name: string; city: string }[]> {
    return db.area.findMany({ select: { id: true, name: true, city: true } });
  }

  importCivilEngineers(
    db: Db = prisma,
  ): Promise<{ id: string; name: string; phone: string; status: PartyStatusValue }[]> {
    return db.civilEngineer.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  importElectricalEngineers(
    db: Db = prisma,
  ): Promise<{ id: string; name: string; phone: string; status: PartyStatusValue }[]> {
    return db.electricalEngineer.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  importContractors(
    db: Db = prisma,
  ): Promise<{ id: string; name: string; phone: string; status: PartyStatusValue }[]> {
    return db.contractor.findMany({ select: { id: true, name: true, phone: true, status: true } });
  }

  // The numbers of every stored villa, and the places (area, block, plot) of the villas in the given areas.
  async storedVillaNumbers(db: Db): Promise<string[]> {
    return (await db.villa.findMany({ select: { villaNumber: true } })).map((row) => row.villaNumber);
  }

  storedPlots(
    areaIds: readonly string[],
    db: Db,
  ): Promise<{ areaId: string; block: string; plot: string }[]> {
    return db.villa.findMany({
      where: { areaId: { in: [...areaIds] } },
      select: { areaId: true, block: true, plot: true },
    });
  }

  // LOCK ORDER, after the phase set: the areas and the parties the file refers to, shared, one table after the other and in
  // the order of their ids, so a party cannot be deleted or switched off between the check and the insert (their own writes
  // wait for this transaction, and take no other lock this one waits for). What is missing from the answer is gone.
  async lockRefsShared(refs: ImportRefs, db: Db): Promise<LockedRefs> {
    const ids = (list: readonly string[]) => Prisma.join([...list].sort());
    const areas =
      refs.areaIds.length === 0
        ? []
        : await db.$queryRaw<{ id: string }[]>(
            Prisma.sql`SELECT "id" FROM "Area" WHERE "id" IN (${ids(refs.areaIds)}) ORDER BY "id" FOR SHARE`,
          );
    const statuses = async (
      table: "CivilEngineer" | "ElectricalEngineer" | "Contractor",
      list: readonly string[],
    ) => {
      if (list.length === 0) {
        return new Map<string, PartyStatusValue>();
      }
      const rows = await db.$queryRaw<{ id: string; status: PartyStatusValue }[]>(
        Prisma.sql`SELECT "id", "status"::text AS "status" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" IN (${ids(list)}) ORDER BY "id" FOR SHARE`,
      );
      return new Map(rows.map((row) => [row.id, row.status]));
    };
    return {
      areas: new Set(areas.map((row) => row.id)),
      civilEngineers: await statuses("CivilEngineer", refs.civilEngineerIds),
      electricalEngineers: await statuses("ElectricalEngineer", refs.electricalEngineerIds),
      contractors: await statuses("Contractor", refs.contractorIds),
    };
  }

  // Saves all the villas in one statement, under ids made here, and returns the ids in the order of the rows.
  async createMany(rows: readonly NewVilla[], db: Db): Promise<string[]> {
    const data = rows.map((row) => ({ ...row, id: randomUUID(), budgetMinor: toBigInt(row.budgetMinor) }));
    await db.villa.createMany({ data });
    return data.map((row) => row.id);
  }

  // A row at 0 for every phase for each of these new villas. Call lockPhaseSet first.
  insertProgressRowsForMany(villaIds: readonly string[], db: Db): Promise<void> {
    return insertRowsForVillas(villaIds, db);
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such villa).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "Villa", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. False: it was not.
  async updateScalars(id: string, version: number, patch: VillaPatch, db: Db = prisma): Promise<boolean> {
    const { count } = await db.villa.updateMany({
      where: { id, version },
      data: {
        ...patch,
        ...(patch.budgetMinor !== undefined && { budgetMinor: toBigInt(patch.budgetMinor) }),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  // Document rows go with it (onDelete: Cascade).
  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.villa.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
