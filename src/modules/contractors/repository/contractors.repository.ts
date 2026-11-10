import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { AlertWindow } from "../../../shared/utils/deadline.js";
import { toDay } from "../../../shared/utils/day.js";
import {
  MAX_OPTIONS,
  type ContractorSort,
  type SummarySection,
  type SummarySort,
} from "../dto/contractors.dto.js";

export type Db = Prisma.TransactionClient;

// `_count` makes Prisma count the linked villas in the same query, so listing never asks once per row.
const select = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { villas: true } },
} satisfies Prisma.ContractorSelect;

export type ContractorRow = Prisma.ContractorGetPayload<{ select: typeof select }>;

const villaSelect = {
  id: true,
  villaNumber: true,
  area: { select: { name: true } },
  block: true,
  plot: true,
  startDate: true,
  targetDate: true,
} satisfies Prisma.VillaSelect;

export type ContractorVillaRow = Prisma.VillaGetPayload<{ select: typeof villaSelect }>;

// One contractor's figures in the other resources (a bigint comes back from count(), a numeric from sum()).
type Count = bigint | number;
export type ContractorFigures = {
  openWorks: {
    total: Count;
    notStarted: Count;
    inProgress: Count;
    delayed: Count;
    done: Count;
    overdue: Count;
  };
  smallWorks: { total: Count; pending: Count; done: Count; overdue: Count; dueSoon: Count };
  dailyReports: { count: Count; lastReportDate: Date | null };
  labour: { entries: Count; totalLabour: Count; lastLabourDate: Date | null };
};

type ListParams = {
  search?: string | undefined;
  status?: PartyStatusValue | undefined;
  sort: ContractorSort;
  skip: number;
  take: number;
};
type VillaListParams = {
  contractorId: string;
  sort: SummarySort;
  skip: number;
  take: number;
};

// The search looks in the name, the phone and the email.
function whereOf(
  search: string | undefined,
  status: PartyStatusValue | undefined,
): Prisma.ContractorWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(status && { status }),
    ...(term && {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows that share a name or a timestamp.
function orderByOf({ field, direction }: ContractorSort): Prisma.ContractorOrderByWithRelationInput[] {
  return field === "name" ? [{ name: direction }, { id: "asc" }] : [{ createdAt: direction }, { id: "asc" }];
}

// Villas without a date always come last, whichever way the dates are sorted.
function villaOrderByOf({ field, direction }: SummarySort): Prisma.VillaOrderByWithRelationInput[] {
  switch (field) {
    case "villaNumber":
      return [{ villaNumber: direction }, { id: "asc" }];
    case "startDate":
      return [{ startDate: { sort: direction, nulls: "last" } }, { villaNumber: "asc" }, { id: "asc" }];
    case "targetDate":
      return [{ targetDate: { sort: direction, nulls: "last" } }, { villaNumber: "asc" }, { id: "asc" }];
  }
}

export class ContractorsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { search, status, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: ContractorRow[]; total: number }> {
    const where = whereOf(search, status);
    const [rows, total] = await Promise.all([
      db.contractor.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.contractor.count({ where }),
    ]);
    return { rows, total };
  }

  // The records a form can offer: the active ones.
  options(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.contractor.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  findById(id: string, db: Db = prisma): Promise<ContractorRow | null> {
    return db.contractor.findUnique({ where: { id }, select });
  }

  create(
    data: { name: string; phone: string; email: string | null; status: PartyStatusValue },
    db: Db = prisma,
  ): Promise<ContractorRow> {
    return db.contractor.create({ data, select });
  }

  // Every contractor whose name is one of these (already lowercased, with single spaces), by whatever case and
  // spacing it was stored in. There is no unique key on a contractor, so an import looks for duplicates here.
  async findByNormalizedNames(
    names: readonly string[],
    db: Db = prisma,
  ): Promise<{ name: string; phone: string }[]> {
    if (names.length === 0) {
      return [];
    }
    return db.$queryRaw<{ name: string; phone: string }[]>`
      SELECT "name", "phone" FROM "Contractor"
      WHERE lower(regexp_replace(btrim("name"), '[[:space:]]+', ' ', 'g')) IN (${Prisma.join(names)})`;
  }

  // Saves all the rows in one statement and returns their ids.
  async createMany(
    rows: readonly { name: string; phone: string; email: string | null; status: PartyStatusValue }[],
    db: Db = prisma,
  ): Promise<string[]> {
    const created = await db.contractor.createManyAndReturn({ data: [...rows], select: { id: true } });
    return created.map((row) => row.id);
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such contractor).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "Contractor", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: { name?: string; phone?: string; email?: string | null; status?: PartyStatusValue },
    db: Db = prisma,
  ): Promise<ContractorRow | null> {
    const { count } = await db.contractor.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.contractor.findUnique({ where: { id }, select }) : null;
  }

  // The foreign key from Villa.contractorId is `onDelete: Restrict`, so this throws (P2003) while villas remain.
  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.contractor.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // Everything that points at the contractor and keeps it from being deleted: villas, open works, daily reports, small works
  // and labour rows. (The foreign keys, RESTRICT, are the backstop for one added meanwhile.)
  async countLinks(contractorId: string, db: Db = prisma): Promise<number> {
    const row = await db.contractor.findUnique({
      where: { id: contractorId },
      select: {
        _count: {
          select: {
            villas: true,
            workItems: true,
            dailyReports: true,
            dailySmallWorks: true,
            dailyLabours: true,
          },
        },
      },
    });
    return Object.values(row?._count ?? {}).reduce((sum, n) => sum + n, 0);
  }

  // The figures of the sections asked for, each one aggregate query over the rows that name the contractor. `today` is the UTC
  // day the open works' overdue rule counts from; `window` the two days of the small works' alert rules.
  async figures(
    contractorId: string,
    sections: readonly SummarySection[],
    today: Date,
    window: AlertWindow,
    db: Db = prisma,
  ): Promise<Partial<ContractorFigures>> {
    const figures: Partial<ContractorFigures> = {};
    const day = toDay(today);
    await Promise.all(
      sections.map(async (section) => {
        switch (section) {
          case "openWorks": {
            const [row] = await db.$queryRaw<ContractorFigures["openWorks"][]>`
              SELECT
                count(*) AS "total",
                count(*) FILTER (WHERE w."status" = 'NOT_STARTED') AS "notStarted",
                count(*) FILTER (WHERE w."status" = 'IN_PROGRESS') AS "inProgress",
                count(*) FILTER (WHERE w."status" = 'DELAYED') AS "delayed",
                count(*) FILTER (WHERE w."status" = 'DONE') AS "done",
                count(*) FILTER (WHERE w."endDate" < ${day}::date AND w."status" <> 'DONE') AS "overdue"
              FROM "WorkItem" w WHERE w."contractorId" = ${contractorId}`;
            if (row) figures.openWorks = row;
            return;
          }
          case "smallWorks": {
            const [row] = await db.$queryRaw<ContractorFigures["smallWorks"][]>`
              SELECT
                count(*) AS "total",
                count(*) FILTER (WHERE w."status" = 'PENDING') AS "pending",
                count(*) FILTER (WHERE w."status" = 'DONE') AS "done",
                count(*) FILTER (WHERE w."status" = 'PENDING' AND w."endDate" < ${window.today}::date) AS "overdue",
                count(*) FILTER (
                  WHERE w."status" = 'PENDING' AND w."endDate" >= ${window.today}::date AND w."endDate" < ${window.horizon}::date
                ) AS "dueSoon"
              FROM "DailySmallWork" w WHERE w."contractorId" = ${contractorId}`;
            if (row) figures.smallWorks = row;
            return;
          }
          case "dailyReports": {
            const [row] = await db.$queryRaw<ContractorFigures["dailyReports"][]>`
              SELECT count(*) AS "count", max(r."reportDate") AS "lastReportDate"
              FROM "DailyReport" r WHERE r."contractorId" = ${contractorId}`;
            if (row) figures.dailyReports = row;
            return;
          }
          case "labour": {
            const [row] = await db.$queryRaw<ContractorFigures["labour"][]>`
              SELECT count(*) AS "entries", COALESCE(sum(l."labourCount"), 0) AS "totalLabour", max(l."labourDate") AS "lastLabourDate"
              FROM "DailyLabour" l WHERE l."contractorId" = ${contractorId}`;
            if (row) figures.labour = row;
            return;
          }
        }
      }),
    );
    return figures;
  }

  async listVillas(
    { contractorId, sort, skip, take }: VillaListParams,
    db: Db = prisma,
  ): Promise<{ rows: ContractorVillaRow[]; total: number }> {
    const where: Prisma.VillaWhereInput = { contractorId };
    const [rows, total] = await Promise.all([
      db.villa.findMany({ where, select: villaSelect, orderBy: villaOrderByOf(sort), skip, take }),
      db.villa.count({ where }),
    ]);
    return { rows, total };
  }
}
