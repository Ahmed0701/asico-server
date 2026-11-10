import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { PHASE_DONE_RATIO, PHASE_PROGRESS } from "../../villa-progress/repository/progress-rows.js";
import { AuditRepository, auditLogListSelect, type AuditLogListRow } from "../../audit/index.js";
import { toDay } from "../../../shared/utils/day.js";
import type { AlertWindow } from "../../../shared/utils/deadline.js";
import { TOP_AREAS, TOP_CONTRACTORS, type DayRange } from "../dto/dashboard.dto.js";

export type Db = Prisma.TransactionClient;

// COUNT comes back from Postgres as a bigint; the mapper turns it into a number.
type Count = bigint | number;

export type VillaCounterRow = {
  total: Count;
  overdue: Count;
  upcoming: Count;
  mewFollowUp: Count;
  mewInspection: Count;
};

// Maintenance villas still open, and solved.
export type MaintenanceCounterRow = { open: Count; solved: Count };

// Progress over all villas: the sum of the villas' overall progress (each at most 100), the number of active phases, and
// how many villas are in each state.
export type ProgressCounterRow = {
  progressSum: Count;
  phaseCount: Count;
  notStarted: Count;
  inProgress: Count;
  done: Count;
};

// Open works: all of them, by status, and how many are overdue (an end date before today and not done: the list's own rule).
export type OpenWorkCounterRow = {
  total: Count;
  notStarted: Count;
  inProgress: Count;
  delayed: Count;
  done: Count;
  overdue: Count;
};
// Rows of today and of the window that ends with it (daily reports); for the labour the sum of the labour counts.
export type DailyCounterRow = { today: Count; last7Days: Count };
export type LabourCounterRow = DailyCounterRow & { total: Count };
// All the small works, the pending ones, and how many of those are due soon and overdue (the list's own rule:
// shared/utils/deadline.ts).
export type SmallWorkCounterRow = { total: Count; pending: Count; dueSoon: Count; overdue: Count };
// A pending small work that is due soon or overdue, with what the dashboard shows of it.
export type UrgentSmallWorkRow = {
  id: string;
  villaId: string;
  villaNumber: string;
  description: string;
  contractorId: string;
  contractorName: string;
  endDate: Date;
};
// An open work past its end date and not done, with what the dashboard shows of it.
export type OverdueOpenWorkRow = {
  id: string;
  villaId: string;
  villaNumber: string;
  phaseName: string;
  contractorName: string | null;
  endDate: Date;
};
// The ratings are added up rather than averaged in the database, so the average is made by whole-number maths in the app.
export type SiteReportCounterRow = { total: Count; ratingSum: Count };

// An audit row with the name of the thing it is about, when one can be found.
export type RecentAuditRow = AuditLogListRow & { entityName: string | null; entityDetail: string | null };

export type AreaCountRow = { areaId: string; area: string; city: string; total: Count };
export type ContractorCountRow = { id: string; name: string; total: Count };

// The target date is a DATE column (a calendar day). A day is handed to Postgres as YYYY-MM-DD text and cast to
// `date`, so no time zone can shift it.
const asDay = (date: Date): string => toDay(date);

// An aggregate over a whole table always answers exactly one row.
function only<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (!row) {
    throw new Error(`the ${what} counters query returned no row`);
  }
  return row;
}

// Everything here is read-only, and every figure comes from the database as a grouped count or one aggregate:
// no row is loaded to be counted in the application.
export class DashboardRepository {
  // The three summary queries run on one snapshot, so the sections always agree with each other.
  snapshot<T>(work: (db: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work, { isolationLevel: "RepeatableRead" });
  }

  // One pass over Villa. A villa without a target date is neither overdue nor upcoming. A villa is ready for inspection
  // when someone marked it (the time is set), whatever its progress.
  async villaCounters({ today, until }: DayRange, db: Db = prisma): Promise<VillaCounterRow> {
    const rows = await db.$queryRaw<VillaCounterRow[]>`
      SELECT
        count(*) AS "total",
        count(*) FILTER (WHERE v."targetDate" < ${asDay(today)}::date) AS "overdue",
        count(*) FILTER (
          WHERE v."targetDate" >= ${asDay(today)}::date
            AND v."targetDate" < ${asDay(until)}::date
        ) AS "upcoming",
        count(*) FILTER (WHERE v."mewFollowUpAt" IS NOT NULL) AS "mewFollowUp",
        count(*) FILTER (
          WHERE v."mewInspectionAt" IS NOT NULL AND v."mewInspectionPassedAt" IS NULL
        ) AS "mewInspection"
      FROM "Villa" v`;
    return only(rows, "villa");
  }

  // One pass over the villas' progress, all derived: a villa's sum over the active phases decides its state. A missing
  // progress row is just a missing term in the sum.
  async progressCounters(db: Db = prisma): Promise<ProgressCounterRow> {
    const rows = await db.$queryRaw<ProgressCounterRow[]>`
      WITH active AS (SELECT count(*) AS "n" FROM "ElecPhase" WHERE "status" = 'ACTIVE'),
      -- Each villa's progress in each active phase, read from its open works (PHASE_PROGRESS), and what the phase adds to
      -- the villa's overall progress (PHASE_DONE_RATIO: its ratio once the open work is done).
      phase AS (
        SELECT v."id" AS "villaId", ${PHASE_PROGRESS} AS "progress", ${PHASE_DONE_RATIO} AS "doneRatio"
        FROM "Villa" v
        CROSS JOIN "ElecPhase" ph
        WHERE ph."status" = 'ACTIVE'
      ),
      per AS (
        SELECT v."id", COALESCE(sum(phase."progress"), 0) AS "total",
          LEAST(100, COALESCE(sum(phase."doneRatio"), 0)) AS "overall"
        FROM "Villa" v
        LEFT JOIN phase ON phase."villaId" = v."id"
        GROUP BY v."id"
      )
      SELECT
        -- The villas' overall progress (the done phases' ratios); the states below follow the open works' progress.
        COALESCE(sum(per."overall"), 0) AS "progressSum",
        (SELECT "n" FROM active) AS "phaseCount",
        count(*) FILTER (WHERE per."total" = 0) AS "notStarted",
        count(*) FILTER (WHERE per."total" > 0 AND per."total" < (SELECT "n" FROM active) * 100) AS "inProgress",
        count(*) FILTER (WHERE (SELECT "n" FROM active) > 0 AND per."total" = (SELECT "n" FROM active) * 100) AS "done"
      FROM per`;
    return only(rows, "progress");
  }

  // The busiest areas first; ties by area name, city and id so the order never changes between calls.
  areaBreakdown(db: Db = prisma): Promise<AreaCountRow[]> {
    return db.$queryRaw<AreaCountRow[]>`
      SELECT
        a."id" AS "areaId",
        a."name" AS "area",
        a."city" AS "city",
        count(*) AS "total"
      FROM "Villa" v
      JOIN "Area" a ON a."id" = v."areaId"
      GROUP BY a."id", a."name", a."city"
      ORDER BY count(*) DESC, a."name" ASC, a."city" ASC, a."id" ASC
      LIMIT ${TOP_AREAS}`;
  }

  // Villas without a contractor are not counted.
  topContractors(db: Db = prisma): Promise<ContractorCountRow[]> {
    return db.$queryRaw<ContractorCountRow[]>`
      SELECT
        c."id" AS "id",
        c."name" AS "name",
        count(*) AS "total"
      FROM "Villa" v
      JOIN "Contractor" c ON c."id" = v."contractorId"
      GROUP BY c."id", c."name"
      ORDER BY count(*) DESC, c."name" ASC, c."id" ASC
      LIMIT ${TOP_CONTRACTORS}`;
  }

  // The most overdue open works: the earliest end date first, then the oldest row. `today` is the APP_TIMEZONE day.
  openWorkOverdue(today: Date, limit: number, db: Db = prisma): Promise<OverdueOpenWorkRow[]> {
    return db.$queryRaw<OverdueOpenWorkRow[]>`
      SELECT w."id", w."villaId", v."villaNumber", p."name" AS "phaseName", c."name" AS "contractorName", w."endDate"
      FROM "WorkItem" w
      JOIN "Villa" v ON v."id" = w."villaId"
      JOIN "ElecPhase" p ON p."id" = w."elecPhaseId"
      LEFT JOIN "Contractor" c ON c."id" = w."contractorId"
      WHERE w."endDate" < ${asDay(today)}::date AND w."status" <> 'DONE'
      ORDER BY w."endDate" ASC, w."createdAt" ASC, w."id" ASC
      LIMIT ${limit}`;
  }

  // Counts by status in one pass; the overdue rule is the open works list's (a DATE compared with the APP_TIMEZONE day).
  async openWorkCounters(today: Date, db: Db = prisma): Promise<OpenWorkCounterRow> {
    const rows = await db.$queryRaw<OpenWorkCounterRow[]>`
      SELECT
        count(*) AS "total",
        count(*) FILTER (WHERE w."status" = 'NOT_STARTED') AS "notStarted",
        count(*) FILTER (WHERE w."status" = 'IN_PROGRESS') AS "inProgress",
        count(*) FILTER (WHERE w."status" = 'DELAYED') AS "delayed",
        count(*) FILTER (WHERE w."status" = 'DONE') AS "done",
        count(*) FILTER (WHERE w."endDate" < ${asDay(today)}::date AND w."status" <> 'DONE') AS "overdue"
      FROM "WorkItem" w`;
    return only(rows, "open works");
  }

  // The reports written for today, and for the window of the last 7 days (the day of the report, not when it was made).
  async dailyReportCounters({ today, weekStart }: DayRange, db: Db = prisma): Promise<DailyCounterRow> {
    const rows = await db.$queryRaw<DailyCounterRow[]>`
      SELECT
        count(*) FILTER (WHERE r."reportDate" = ${asDay(today)}::date) AS "today",
        count(*) FILTER (
          WHERE r."reportDate" >= ${asDay(weekStart)}::date AND r."reportDate" <= ${asDay(today)}::date
        ) AS "last7Days"
      FROM "DailyReport" r`;
    return only(rows, "daily reports");
  }

  async smallWorkCounters({ today, horizon }: AlertWindow, db: Db = prisma): Promise<SmallWorkCounterRow> {
    const rows = await db.$queryRaw<SmallWorkCounterRow[]>`
      SELECT
        count(*) AS "total",
        count(*) FILTER (WHERE w."status" = 'PENDING') AS "pending",
        count(*) FILTER (
          WHERE w."status" = 'PENDING' AND w."endDate" >= ${today}::date AND w."endDate" < ${horizon}::date
        ) AS "dueSoon",
        count(*) FILTER (WHERE w."status" = 'PENDING' AND w."endDate" < ${today}::date) AS "overdue"
      FROM "DailySmallWork" w`;
    return only(rows, "small works");
  }

  // The most urgent pending small works that are overdue or due soon: the earliest end date first (an overdue work always
  // ends before a due soon one), then the oldest row.
  smallWorkUrgent({ horizon }: AlertWindow, limit: number, db: Db = prisma): Promise<UrgentSmallWorkRow[]> {
    return db.$queryRaw<UrgentSmallWorkRow[]>`
      SELECT w."id", w."villaId", v."villaNumber", w."description", w."contractorId", c."name" AS "contractorName", w."endDate"
      FROM "DailySmallWork" w
      JOIN "Villa" v ON v."id" = w."villaId"
      JOIN "Contractor" c ON c."id" = w."contractorId"
      WHERE w."status" = 'PENDING' AND w."endDate" < ${horizon}::date
      ORDER BY w."endDate" ASC, w."createdAt" ASC, w."id" ASC
      LIMIT ${limit}`;
  }

  async siteReportCounters(db: Db = prisma): Promise<SiteReportCounterRow> {
    const rows = await db.$queryRaw<SiteReportCounterRow[]>`
      SELECT count(*) AS "total", COALESCE(sum(r."rating"), 0) AS "ratingSum"
      FROM "SiteReport" r`;
    return only(rows, "site reports");
  }

  // The labourers of today and of the window, added up (not the number of rows).
  async labourCounters({ today, weekStart }: DayRange, db: Db = prisma): Promise<LabourCounterRow> {
    const rows = await db.$queryRaw<LabourCounterRow[]>`
      SELECT
        COALESCE(sum(l."labourCount") FILTER (WHERE l."labourDate" = ${asDay(today)}::date), 0) AS "today",
        COALESCE(sum(l."labourCount") FILTER (
          WHERE l."labourDate" >= ${asDay(weekStart)}::date AND l."labourDate" <= ${asDay(today)}::date
        ), 0) AS "last7Days",
        COALESCE(sum(l."labourCount"), 0) AS "total"
      FROM "DailyLabour" l`;
    return only(rows, "labour");
  }

  // The workers of every labour daily report added up (DailyReport.workersCount), all dates: the total labour card.
  async dailyReportWorkers(db: Db = prisma): Promise<{ total: Count }> {
    const rows = await db.$queryRaw<{ total: Count }[]>`
      SELECT COALESCE(sum(r."workersCount"), 0) AS "total"
      FROM "DailyReport" r`;
    return only(rows, "daily report workers");
  }

  async maintenanceCounters(db: Db = prisma): Promise<MaintenanceCounterRow> {
    const rows = await db.$queryRaw<MaintenanceCounterRow[]>`
      SELECT
        count(*) FILTER (WHERE m."solvedAt" IS NULL) AS "open",
        count(*) FILTER (WHERE m."solvedAt" IS NOT NULL) AS "solved"
      FROM "MaintenanceVilla" m`;
    return only(rows, "maintenance");
  }

  // The codes an EMPLOYEE has been granted (an ADMIN holds every one by role and has no rows).
  async grantedCodes(userId: string, db: Db = prisma): Promise<string[]> {
    const grants = await db.userPermission.findMany({
      where: { userId },
      select: { permission: { select: { code: true } } },
    });
    return grants.map((grant) => grant.permission.code);
  }

  // The newest audit rows, from the createdAt index, with the audit list's own select (no before/after), and the
  // name of what each is about, read in one query per kind of entity by the audit module's own lookup.
  // No count: the audit table only grows, and the dashboard does not need a total.
  async recentAudit(limit: number, db: Db = prisma): Promise<RecentAuditRow[]> {
    const rows = await db.auditLog.findMany({
      select: auditLogListSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit,
    });
    const refs = await new AuditRepository().entityRefs(rows, db);
    return rows.map((row) => ({
      ...row,
      entityName: refs.get(row.id)?.name ?? null,
      entityDetail: refs.get(row.id)?.detail ?? null,
    }));
  }
}
