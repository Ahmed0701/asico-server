import { randomUUID } from "node:crypto";
import {
  type DailyReportFilters,
  type DailyReportSort,
} from "../../../src/modules/daily-reports/dto/daily-reports.dto.js";
import type {
  DailyReportPatch,
  DailyReportRow,
  DailyReportsRepository,
  Db,
  ImportParty,
  NewDailyReport,
} from "../../../src/modules/daily-reports/repository/daily-reports.repository.js";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { electricalTables } from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { dailyReportTables, type StoredDailyReport } from "./daily-report-tables.js";

export { dailyReportTables, type StoredDailyReport } from "./daily-report-tables.js";

export const CONTRACTOR_FK = "DailyReport_contractorId_fkey";
export const ENGINEER_FK = "DailyReport_preparedByEngineerId_fkey";
export const DAY_UNIQUE = "DailyReport_contractorId_reportDate_key";

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.
const databaseError = (code: string, constraint: string): Error =>
  Object.assign(new Error(`Prisma ${code}`), {
    code,
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
export const foreignKeyError = (constraint: string): Error => databaseError("P2003", constraint);
export const uniqueError = (constraint: string): Error => databaseError("P2002", constraint);
const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

// Race switches of the daily reports: each runs once, when the next transaction starts, to do what another request would
// do between the service's checks and its write.
export const dailyReportRaces = {
  beforeWrite: null as (() => void) | null,
  // Runs once, when the import locks its contractors: after the file was checked and before the rows are written.
  beforeImportLock: null as (() => void) | null,
  reset(): void {
    this.beforeWrite = null;
    this.beforeImportLock = null;
  },
};

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

let counter = 0;
// A report as the table holds it. The contractor and the engineer must exist when the test reads it back as a row.
export function addDailyReport(
  overrides: Partial<StoredDailyReport> & { contractorId: string; preparedByEngineerId: string },
): StoredDailyReport {
  counter += 1;
  const now = new Date();
  const report: StoredDailyReport = {
    id: randomUUID(),
    reportDate: new Date(Date.UTC(2026, 0, 1 + (counter % 28))),
    weather: "SUNNY",
    workersCount: 10,
    notes: null,
    createdById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  dailyReportTables.reports.push(report);
  return report;
}

function toRow(report: StoredDailyReport): DailyReportRow {
  const contractor = contractorTables.contractors.find((c) => c.id === report.contractorId);
  if (!contractor) throw new Error("the report's contractor is missing");
  const engineer = electricalTables.engineers.find((e) => e.id === report.preparedByEngineerId);
  if (!engineer) throw new Error("the report's engineer is missing");
  const creator = report.createdById ? store.users.find((u) => u.id === report.createdById) : undefined;
  return {
    id: report.id,
    reportDate: report.reportDate,
    weather: report.weather,
    workersCount: report.workersCount,
    notes: report.notes,
    contractorId: report.contractorId,
    preparedByEngineerId: report.preparedByEngineerId,
    version: report.version,
    createdById: report.createdById,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    contractor: { id: contractor.id, name: contractor.name },
    preparedByEngineer: { id: engineer.id, name: engineer.name },
    createdBy: creator ? { id: creator.id, name: creator.name } : null,
  };
}

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const byId = (a: StoredDailyReport, b: StoredDailyReport): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function matches(report: StoredDailyReport, filters: DailyReportFilters): boolean {
  const needle = filters.search?.toLowerCase();
  return (
    (!filters.contractorId || report.contractorId === filters.contractorId) &&
    (!filters.preparedByEngineerId || report.preparedByEngineerId === filters.preparedByEngineerId) &&
    (!filters.weather || report.weather === filters.weather) &&
    (!filters.reportFrom || dayOf(report.reportDate) >= dayOf(filters.reportFrom)) &&
    (!filters.reportTo || dayOf(report.reportDate) <= dayOf(filters.reportTo)) &&
    (!needle || (report.notes ?? "").toLowerCase().includes(needle))
  );
}

const contractorName = (report: StoredDailyReport): string =>
  contractorTables.contractors.find((c) => c.id === report.contractorId)!.name;
const engineerName = (report: StoredDailyReport): string =>
  electricalTables.engineers.find((e) => e.id === report.preparedByEngineerId)!.name;

const WEATHER_ORDER = ["HOT", "SUNNY", "WINDY", "RAINY", "DUSTY"];

function compare(a: StoredDailyReport, b: StoredDailyReport, { field, direction }: DailyReportSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const newestFirst = b.reportDate.getTime() - a.reportDate.getTime();
  switch (field) {
    case "reportDate":
      return (a.reportDate.getTime() - b.reportDate.getTime()) * sign || byId(a, b);
    case "contractorName":
      return natural(contractorName(a), contractorName(b)) * sign || newestFirst || byId(a, b);
    case "preparedByName":
      return natural(engineerName(a), engineerName(b)) * sign || newestFirst || byId(a, b);
    case "weather":
      return (
        (WEATHER_ORDER.indexOf(a.weather) - WEATHER_ORDER.indexOf(b.weather)) * sign ||
        newestFirst ||
        byId(a, b)
      );
    case "createdAt":
      return (a.createdAt.getTime() - b.createdAt.getTime()) * sign || byId(a, b);
  }
}

// Plain-memory stand-in for the daily reports' queries. Contractors, engineers and users are read from the other modules'
// fakes, so a report can only point at ones that exist, as the foreign keys demand. The unique index on (contractor, day) is
// enforced the way the database does.
export class InMemoryDailyReportsRepository implements DailyReportsRepository {
  // Transactions take turns, as they would behind the row locks (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const race = dailyReportRaces.beforeWrite;
    dailyReportRaces.beforeWrite = null;
    race?.();
    const before = structuredClone(dailyReportTables.reports);
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      dailyReportTables.reports = before;
      throw err;
    }
  }

  async list(params: { filters: DailyReportFilters; sort: DailyReportSort; skip: number; take: number }) {
    const matching = dailyReportTables.reports
      .filter((report) => matches(report, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<DailyReportRow | null> {
    const report = dailyReportTables.reports.find((candidate) => candidate.id === id);
    return report ? toRow(report) : null;
  }

  async lockVersion(id: string): Promise<number | null> {
    return dailyReportTables.reports.find((candidate) => candidate.id === id)?.version ?? null;
  }

  private assertDayFree(contractorId: string, reportDate: Date, exceptId?: string): void {
    const taken = dailyReportTables.reports.some(
      (report) =>
        report.id !== exceptId &&
        report.contractorId === contractorId &&
        dayOf(report.reportDate) === dayOf(reportDate),
    );
    if (taken) throw uniqueError(DAY_UNIQUE);
  }

  private assertParties(contractorId: string | undefined, engineerId: string | undefined): void {
    if (contractorId && !contractorTables.contractors.some((c) => c.id === contractorId)) {
      throw foreignKeyError(CONTRACTOR_FK);
    }
    if (engineerId && !electricalTables.engineers.some((e) => e.id === engineerId)) {
      throw foreignKeyError(ENGINEER_FK);
    }
  }

  async create(data: NewDailyReport): Promise<DailyReportRow> {
    this.assertParties(data.contractorId, data.preparedByEngineerId);
    this.assertDayFree(data.contractorId, data.reportDate);
    return toRow(addDailyReport(data));
  }

  async update(id: string, version: number, patch: DailyReportPatch): Promise<DailyReportRow | null> {
    const report = dailyReportTables.reports.find((candidate) => candidate.id === id);
    if (!report || report.version !== version) return null;
    this.assertParties(patch.contractorId, patch.preparedByEngineerId);
    this.assertDayFree(patch.contractorId ?? report.contractorId, patch.reportDate ?? report.reportDate, id);
    Object.assign(report, patch, { version: report.version + 1, updatedAt: new Date() });
    return toRow(report);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const report = dailyReportTables.reports.find((candidate) => candidate.id === id);
    if (!report) throw missingRowError();
    if (report.version !== version) return false;
    dailyReportTables.reports = dailyReportTables.reports.filter((candidate) => candidate.id !== id);
    return true;
  }

  async contractorStatus(id: string): Promise<PartyStatusValue | null> {
    return contractorTables.contractors.find((c) => c.id === id)?.status ?? null;
  }

  async engineerStatus(id: string): Promise<PartyStatusValue | null> {
    return electricalTables.engineers.find((e) => e.id === id)?.status ?? null;
  }

  async userExists(id: string): Promise<boolean> {
    return store.users.some((user) => user.id === id);
  }

  // ---- the import's queries ----

  async importContractors(): Promise<ImportParty[]> {
    return contractorTables.contractors.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
    }));
  }

  async importEngineers(): Promise<ImportParty[]> {
    return electricalTables.engineers.map((e) => ({
      id: e.id,
      name: e.name,
      phone: e.phone,
      status: e.status,
    }));
  }

  async existingDays(
    contractorIds: readonly string[],
  ): Promise<{ contractorId: string; reportDate: Date }[]> {
    return dailyReportTables.reports
      .filter((report) => contractorIds.includes(report.contractorId))
      .map((report) => ({ contractorId: report.contractorId, reportDate: report.reportDate }));
  }

  async lockContractorsShared(ids: readonly string[]): Promise<Map<string, PartyStatusValue>> {
    const race = dailyReportRaces.beforeImportLock;
    dailyReportRaces.beforeImportLock = null;
    race?.();
    return new Map(
      contractorTables.contractors.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.status] as const),
    );
  }

  async lockEngineersShared(ids: readonly string[]): Promise<Map<string, PartyStatusValue>> {
    return new Map(
      electricalTables.engineers.filter((e) => ids.includes(e.id)).map((e) => [e.id, e.status] as const),
    );
  }

  async createMany(rows: readonly NewDailyReport[]): Promise<string[]> {
    for (const row of rows) this.assertParties(row.contractorId, row.preparedByEngineerId);
    return rows.map((row) => {
      this.assertDayFree(row.contractorId, row.reportDate);
      return addDailyReport(row).id;
    });
  }
}
