import { openWorkProgressOf } from "../open-works/work-item-tables.js";
import { doneRatioOf, villaProgressOf } from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";
import type {
  AreaCountRow,
  ContractorCountRow,
  DailyCounterRow,
  LabourCounterRow,
  MaintenanceCounterRow,
  DashboardRepository,
  Db,
  OpenWorkCounterRow,
  OverdueOpenWorkRow,
  ProgressCounterRow,
  SiteReportCounterRow,
  SmallWorkCounterRow,
  UrgentSmallWorkRow,
  VillaCounterRow,
  RecentAuditRow,
} from "../../../src/modules/dashboard/repository/dashboard.repository.js";
import type { AuditLogListRow } from "../../../src/modules/audit/index.js";
import {
  TOP_AREAS,
  TOP_CONTRACTORS,
  type DayRange,
} from "../../../src/modules/dashboard/dto/dashboard.dto.js";
import type { AlertWindow } from "../../../src/shared/utils/deadline.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { siteReportTables } from "../site-reports/site-report-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { InMemoryAuditRepository, type StoredAuditRow } from "../audit/in-memory-audit.repository.js";
import { maintenanceTables } from "../maintenance/maintenance-tables.js";

// The dashboard's figures worked out in plain JavaScript over the fakes' tables. The real queries are SQL; the
// dry run checks those against the real database. This is what lets the service and routes be tested without one.

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class InMemoryDashboardRepository implements DashboardRepository {
  async snapshot<T>(work: (db: Db) => Promise<T>): Promise<T> {
    return work(undefined as unknown as Db);
  }

  async villaCounters({ today, until }: DayRange): Promise<VillaCounterRow> {
    const villas = villaTables.villas;
    const targetAt = (villa: StoredVilla): number | null => villa.targetDate?.getTime() ?? null;
    return {
      total: villas.length,
      // A villa without a target date is neither overdue nor upcoming.
      overdue: villas.filter((villa) => {
        const t = targetAt(villa);
        return t !== null && t < today.getTime();
      }).length,
      upcoming: villas.filter((villa) => {
        const t = targetAt(villa);
        return t !== null && t >= today.getTime() && t < until.getTime();
      }).length,
      // Put on the MEW follow-up list by a person; never worked out from the progress.
      mewFollowUp: villas.filter((villa) => villa.mewFollowUpAt !== null).length,
      // On the MEW inspection list and not passed yet.
      mewInspection: villas.filter(
        (villa) => villa.mewInspectionAt !== null && villa.mewInspectionPassedAt === null,
      ).length,
    };
  }

  // Each villa's sum over the active phases decides its state; a missing row is a missing term.
  async progressCounters(): Promise<ProgressCounterRow> {
    const active = phaseTables.phases.filter((phase) => phase.status === "ACTIVE");
    const sums = villaTables.villas.map((villa) =>
      active.reduce((sum, phase) => sum + openWorkProgressOf(villa.id, phase.id), 0),
    );
    const full = active.length * 100;
    // Each villa's overall progress is what its done phases add up to (doneRatioOf), at most 100; the states follow the
    // open works' progress.
    const overall = villaTables.villas.map((villa) =>
      villaProgressOf(
        active.reduce(
          (sum, phase) =>
            sum +
            doneRatioOf({
              progress: openWorkProgressOf(villa.id, phase.id),
              progressRatio: phase.progressRatio,
            }),
          0,
        ),
      ),
    );
    return {
      progressSum: overall.reduce((sum, value) => sum + value, 0),
      phaseCount: active.length,
      notStarted: sums.filter((sum) => sum === 0).length,
      inProgress: sums.filter((sum) => sum > 0 && sum < full).length,
      done: sums.filter((sum) => active.length > 0 && sum === full).length,
    };
  }

  async areaBreakdown(): Promise<AreaCountRow[]> {
    const groups = new Map<string, StoredVilla[]>();
    for (const villa of villaTables.villas) {
      groups.set(villa.areaId, [...(groups.get(villa.areaId) ?? []), villa]);
    }
    return [...groups.entries()]
      .flatMap(([areaId, rows]) => {
        const area = areaTables.areas.find((a) => a.id === areaId);
        return area ? [{ areaId, area: area.name, city: area.city, total: rows.length }] : [];
      })
      .sort(
        (a, b) =>
          b.total - a.total ||
          byCodeUnit(a.area, b.area) ||
          byCodeUnit(a.city, b.city) ||
          byCodeUnit(a.areaId, b.areaId),
      )
      .slice(0, TOP_AREAS);
  }

  async topContractors(): Promise<ContractorCountRow[]> {
    const groups = new Map<string, ContractorCountRow & { total: number }>();
    for (const villa of villaTables.villas) {
      const contractor = contractorTables.contractors.find((c) => c.id === villa.contractorId);
      if (!contractor) continue;
      const entry = groups.get(contractor.id) ?? { id: contractor.id, name: contractor.name, total: 0 };
      entry.total += 1;
      groups.set(contractor.id, entry);
    }
    return [...groups.values()]
      .sort((a, b) => b.total - a.total || byCodeUnit(a.name, b.name) || byCodeUnit(a.id, b.id))
      .slice(0, TOP_CONTRACTORS);
  }

  async openWorkOverdue(today: Date, limit: number): Promise<OverdueOpenWorkRow[]> {
    return workItemTables.items
      .filter(
        (item) => item.endDate !== null && item.endDate.getTime() < today.getTime() && item.status !== "DONE",
      )
      .sort(
        (a, b) =>
          a.endDate!.getTime() - b.endDate!.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          byCodeUnit(a.id, b.id),
      )
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        villaId: item.villaId,
        villaNumber: villaTables.villas.find((villa) => villa.id === item.villaId)?.villaNumber ?? "",
        phaseName: phaseTables.phases.find((phase) => phase.id === item.elecPhaseId)?.name ?? "",
        contractorName:
          item.contractorId === null
            ? null
            : (contractorTables.contractors.find((c) => c.id === item.contractorId)?.name ?? null),
        endDate: item.endDate!,
      }));
  }

  async maintenanceCounters(): Promise<MaintenanceCounterRow> {
    const rows = maintenanceTables.rows;
    return {
      open: rows.filter((row) => row.solvedAt === null).length,
      solved: rows.filter((row) => row.solvedAt !== null).length,
    };
  }

  async dailyReportWorkers(): Promise<{ total: number }> {
    return {
      total: dailyReportTables.reports.reduce((sum, report) => sum + report.workersCount, 0),
    };
  }

  async openWorkCounters(today: Date): Promise<OpenWorkCounterRow> {
    const items = workItemTables.items;
    const count = (status: string): number => items.filter((item) => item.status === status).length;
    return {
      total: items.length,
      notStarted: count("NOT_STARTED"),
      inProgress: count("IN_PROGRESS"),
      delayed: count("DELAYED"),
      done: count("DONE"),
      // The list's rule: an end date before today, and not done. No end date is never overdue.
      overdue: items.filter(
        (item) => item.endDate !== null && item.endDate.getTime() < today.getTime() && item.status !== "DONE",
      ).length,
    };
  }

  async dailyReportCounters({ today, weekStart }: DayRange): Promise<DailyCounterRow> {
    const days = dailyReportTables.reports.map((report) => report.reportDate.getTime());
    return {
      today: days.filter((day) => day === today.getTime()).length,
      last7Days: days.filter((day) => day >= weekStart.getTime() && day <= today.getTime()).length,
    };
  }

  // The same two days the list's filters use: overdue before today, due soon from today up to (not including) the horizon.
  async smallWorkCounters({ today, horizon }: AlertWindow): Promise<SmallWorkCounterRow> {
    const pending = smallWorkTables.works.filter((work) => work.status === "PENDING");
    const endOf = (work: { endDate: Date }): string => work.endDate.toISOString().slice(0, 10);
    return {
      total: smallWorkTables.works.length,
      pending: pending.length,
      dueSoon: pending.filter((work) => endOf(work) >= today && endOf(work) < horizon).length,
      overdue: pending.filter((work) => endOf(work) < today).length,
    };
  }

  // Earliest end date first, then the oldest row.
  async smallWorkUrgent({ horizon }: AlertWindow, limit: number): Promise<UrgentSmallWorkRow[]> {
    return smallWorkTables.works
      .filter((work) => work.status === "PENDING" && work.endDate.toISOString().slice(0, 10) < horizon)
      .sort(
        (a, b) =>
          a.endDate.getTime() - b.endDate.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, limit)
      .map((work) => ({
        id: work.id,
        villaId: work.villaId,
        villaNumber: villaTables.villas.find((villa) => villa.id === work.villaId)!.villaNumber,
        description: work.description,
        contractorId: work.contractorId,
        contractorName: contractorTables.contractors.find((c) => c.id === work.contractorId)!.name,
        endDate: work.endDate,
      }));
  }

  async siteReportCounters(): Promise<SiteReportCounterRow> {
    const reports = siteReportTables.reports;
    return { total: reports.length, ratingSum: reports.reduce((sum, report) => sum + report.rating, 0) };
  }

  async labourCounters({ today, weekStart }: DayRange): Promise<LabourCounterRow> {
    const rows = dailyLabourTables.rows;
    const sum = (inWindow: (day: number) => boolean): number =>
      rows
        .filter((row) => inWindow(row.labourDate.getTime()))
        .reduce((total, row) => total + row.labourCount, 0);
    return {
      today: sum((day) => day === today.getTime()),
      last7Days: sum((day) => day >= weekStart.getTime() && day <= today.getTime()),
      total: rows.reduce((acc, row) => acc + row.labourCount, 0),
    };
  }

  // An ADMIN has no rows; an employee has the codes the auth fake granted.
  async grantedCodes(userId: string): Promise<string[]> {
    return store.grants.filter((grant) => grant.userId === userId).map((grant) => grant.code);
  }

  async recentAudit(limit: number): Promise<RecentAuditRow[]> {
    const stored = store.auditRows as unknown as StoredAuditRow[];
    const rows: AuditLogListRow[] = [...stored]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byCodeUnit(a.id, b.id))
      .slice(0, limit)
      .map((row) => {
        const actor = store.users.find((u) => u.id === row.actorId);
        return {
          id: row.id,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId ?? null,
          ip: row.ip ?? null,
          userAgent: row.userAgent ?? null,
          requestId: row.requestId ?? null,
          createdAt: row.createdAt,
          actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null,
        };
      });
    // The names come from the audit fake, which reads the other modules' fakes the way the real lookup reads tables.
    const refs = await new InMemoryAuditRepository().entityRefs(rows);
    return rows.map((row) => ({
      ...row,
      entityName: refs.get(row.id)?.name ?? null,
      entityDetail: refs.get(row.id)?.detail ?? null,
    }));
  }
}
