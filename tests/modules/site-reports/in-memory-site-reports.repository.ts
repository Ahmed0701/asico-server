import { randomUUID } from "node:crypto";
import type {
  SiteReportFilters,
  SiteReportSort,
} from "../../../src/modules/site-reports/dto/site-reports.dto.js";
import type {
  Db,
  ImportVillaRef,
  NewSiteReport,
  SiteReportPatch,
  SiteReportRow,
  SiteReportsRepository,
} from "../../../src/modules/site-reports/repository/site-reports.repository.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { siteReportTables, type StoredSiteReport } from "./site-report-tables.js";

export { siteReportTables, type StoredSiteReport } from "./site-report-tables.js";

export const VILLA_FK = "SiteReport_villaId_fkey";

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.
export const foreignKeyError = (constraint: string): Error =>
  Object.assign(new Error("Prisma P2003"), {
    code: "P2003",
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

// Race switches of the site reports: each runs once, when the next transaction starts (or, for the import, when it locks its
// villas), to do what another request would do between the service's checks and its write.
export const siteReportRaces = {
  beforeWrite: null as (() => void) | null,
  beforeImportLock: null as (() => void) | null,
  reset(): void {
    this.beforeWrite = null;
    this.beforeImportLock = null;
  },
};

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

let counter = 0;
// A site report as the table holds it. The villa must exist when the test reads it back as a row.
export function addSiteReport(overrides: Partial<StoredSiteReport> & { villaId: string }): StoredSiteReport {
  counter += 1;
  const now = new Date();
  const report: StoredSiteReport = {
    id: randomUUID(),
    title: `Site report ${counter}`,
    visitDate: new Date(Date.UTC(2026, 0, 1 + (counter % 28))),
    inspector: "Eng. Hamdy",
    type: "INSPECTION",
    rating: 3,
    findings: `Findings ${counter}`,
    recommendations: null,
    createdById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  siteReportTables.reports.push(report);
  return report;
}

function toRow(report: StoredSiteReport): SiteReportRow {
  const villa = villaTables.villas.find((v) => v.id === report.villaId);
  if (!villa) throw new Error("the site report's villa is missing");
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  const creator = report.createdById ? store.users.find((u) => u.id === report.createdById) : undefined;
  return {
    id: report.id,
    visitDate: report.visitDate,
    title: report.title,
    inspector: report.inspector,
    type: report.type,
    rating: report.rating,
    findings: report.findings,
    recommendations: report.recommendations,
    version: report.version,
    createdById: report.createdById,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    villa: {
      id: villa.id,
      villaNumber: villa.villaNumber,
      block: villa.block,
      plot: villa.plot,
      area: { name: area?.name ?? "" },
    },
    createdBy: creator ? { id: creator.id, name: creator.name } : null,
  };
}

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const byId = (a: StoredSiteReport, b: StoredSiteReport): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const TYPE_ORDER = ["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"];

function matches(report: StoredSiteReport, filters: SiteReportFilters): boolean {
  const needle = filters.search?.toLowerCase();
  const villa = villaTables.villas.find((v) => v.id === report.villaId);
  return (
    (!filters.villaId || report.villaId === filters.villaId) &&
    (!filters.type || report.type === filters.type) &&
    (filters.rating === undefined || report.rating === filters.rating) &&
    (!filters.visitFrom || dayOf(report.visitDate) >= dayOf(filters.visitFrom)) &&
    (!filters.visitTo || dayOf(report.visitDate) <= dayOf(filters.visitTo)) &&
    (!needle ||
      [report.title, report.inspector, villa?.villaNumber ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ))
  );
}

function compare(a: StoredSiteReport, b: StoredSiteReport, { field, direction }: SiteReportSort): number {
  const sign = direction === "asc" ? 1 : -1;
  switch (field) {
    case "visitDate":
      return (a.visitDate.getTime() - b.visitDate.getTime()) * sign || byId(a, b);
    case "villaNumber": {
      const left = villaTables.villas.find((v) => v.id === a.villaId)!.villaNumber;
      const right = villaTables.villas.find((v) => v.id === b.villaId)!.villaNumber;
      return natural(left, right) * sign || b.visitDate.getTime() - a.visitDate.getTime() || byId(a, b);
    }
    case "rating":
      return (a.rating - b.rating) * sign || byId(a, b);
    case "type":
      // The enum's own order, as the database sorts it.
      return (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) * sign || byId(a, b);
    case "createdAt":
      return (a.createdAt.getTime() - b.createdAt.getTime()) * sign || byId(a, b);
  }
}

// Plain-memory stand-in for the site reports' queries. Villas and users are read from the other modules' fakes, so a site
// report can only point at a villa that exists, as the foreign key demands.
export class InMemorySiteReportsRepository implements Pick<
  SiteReportsRepository,
  keyof SiteReportsRepository
> {
  // Transactions take turns, as they would behind the row locks (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const race = siteReportRaces.beforeWrite;
    siteReportRaces.beforeWrite = null;
    race?.();
    const before = siteReportTables.reports.map((report) => ({ ...report }));
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      siteReportTables.reports = before;
      throw err;
    }
  }

  async list(params: { filters: SiteReportFilters; sort: SiteReportSort; skip: number; take: number }) {
    const matching = siteReportTables.reports
      .filter((report) => matches(report, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<SiteReportRow | null> {
    const report = siteReportTables.reports.find((candidate) => candidate.id === id);
    return report ? toRow(report) : null;
  }

  async findVillaId(id: string): Promise<string | null> {
    return siteReportTables.reports.find((candidate) => candidate.id === id)?.villaId ?? null;
  }

  async lockVillaShared(villaId: string): Promise<boolean> {
    return villaTables.villas.some((candidate) => candidate.id === villaId);
  }

  async lockVersion(id: string): Promise<number | null> {
    return siteReportTables.reports.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async create(data: NewSiteReport): Promise<SiteReportRow> {
    if (!villaTables.villas.some((v) => v.id === data.villaId)) throw foreignKeyError(VILLA_FK);
    return toRow(addSiteReport(data));
  }

  async update(id: string, version: number, patch: SiteReportPatch): Promise<SiteReportRow | null> {
    const report = siteReportTables.reports.find((candidate) => candidate.id === id);
    if (!report || report.version !== version) return null;
    Object.assign(report, patch, { version: report.version + 1, updatedAt: new Date() });
    return toRow(report);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const report = siteReportTables.reports.find((candidate) => candidate.id === id);
    if (!report) throw missingRowError();
    if (report.version !== version) return false;
    siteReportTables.reports = siteReportTables.reports.filter((candidate) => candidate.id !== id);
    return true;
  }

  // ---- the import's queries ----

  async importVillas(): Promise<ImportVillaRef[]> {
    return villaTables.villas.map((v) => ({ id: v.id, villaNumber: v.villaNumber }));
  }

  async userExists(id: string): Promise<boolean> {
    return store.users.some((user) => user.id === id);
  }

  async lockVillasShared(villaIds: readonly string[]): Promise<Set<string>> {
    const race = siteReportRaces.beforeImportLock;
    siteReportRaces.beforeImportLock = null;
    race?.();
    return new Set(villaTables.villas.filter((v) => villaIds.includes(v.id)).map((v) => v.id));
  }

  async createMany(rows: readonly NewSiteReport[]): Promise<string[]> {
    for (const row of rows) {
      if (!villaTables.villas.some((v) => v.id === row.villaId)) throw foreignKeyError(VILLA_FK);
    }
    return rows.map((row) => addSiteReport(row).id);
  }
}
