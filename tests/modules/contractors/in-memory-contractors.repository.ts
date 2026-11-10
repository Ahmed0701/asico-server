import { randomUUID } from "node:crypto";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import {
  MAX_OPTIONS,
  type ContractorSort,
  type SummarySort,
} from "../../../src/modules/contractors/dto/contractors.dto.js";
import type {
  ContractorVillaRow,
  ContractorRow,
  ContractorFigures,
  ContractorsRepository,
  Db,
} from "../../../src/modules/contractors/repository/contractors.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import type { SummarySection } from "../../../src/modules/contractors/dto/contractors.dto.js";
import type { AlertWindow } from "../../../src/shared/utils/deadline.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

type StoredContractor = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: PartyStatusValue;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
type StoredVilla = {
  id: string;
  villaNumber: string;
  area: string;
  block: string;
  plot: string;
  contractorId: string | null;
  startDate: Date | null;
  targetDate: Date | null;
};

// Plain-memory stand-in for the Contractor and Villa tables (a villa has one contractor, or none).
export const contractorTables = {
  contractors: [] as StoredContractor[],
  villas: [] as StoredVilla[],
  // Race switches: each simulates something another request does between the service's lookup and its write.
  linkVillaBeforeDelete: false,
  removeBeforeWrite: false,

  reset(): void {
    this.contractors = [];
    this.villas = [];
    dailyLabourTables.reset();
    dailyReportTables.reset();
    smallWorkTables.reset();
    workItemTables.reset();
    this.linkVillaBeforeDelete = false;
    this.removeBeforeWrite = false;
  },
};

export function addContractor(overrides: Partial<StoredContractor> & { name: string }): StoredContractor {
  const now = new Date();
  const contractor: StoredContractor = {
    id: randomUUID(),
    phone: "0100 123 4567",
    email: null,
    status: "ACTIVE",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  contractorTables.contractors.push(contractor);
  return contractor;
}

let villaCounter = 0;
export function addVilla(overrides: Partial<StoredVilla> = {}): StoredVilla {
  villaCounter += 1;
  const villa: StoredVilla = {
    id: randomUUID(),
    villaNumber: `P-${String(villaCounter).padStart(4, "0")}`,
    area: "Area",
    block: "B",
    plot: String(villaCounter),
    contractorId: null,
    startDate: null,
    targetDate: null,
    ...overrides,
  };
  contractorTables.villas.push(villa);
  return villa;
}

// Gives the villa this contractor.
export function linkVilla(contractorId: string, villaId: string): void {
  const villa = contractorTables.villas.find((candidate) => candidate.id === villaId);
  if (villa) villa.contractorId = contractorId;
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

// Every record that names the contractor and blocks its deletion (the foreign keys are RESTRICT).
const linksOf = (id: string): number =>
  contractorTables.villas.filter((villa) => villa.contractorId === id).length +
  workItemTables.items.filter((item) => item.contractorId === id).length +
  smallWorkTables.works.filter((work) => work.contractorId === id).length +
  dailyReportTables.reports.filter((report) => report.contractorId === id).length +
  dailyLabourTables.rows.filter((row) => row.contractorId === id).length;

const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

function toRow(contractor: StoredContractor): ContractorRow {
  return {
    id: contractor.id,
    name: contractor.name,
    phone: contractor.phone,
    email: contractor.email,
    status: contractor.status,
    version: contractor.version,
    createdAt: contractor.createdAt,
    updatedAt: contractor.updatedAt,
    _count: {
      villas: contractorTables.villas.filter((villa) => villa.contractorId === contractor.id).length,
    },
  };
}

function compare(a: StoredContractor, b: StoredContractor, { field, direction }: ContractorSort): number {
  const left = field === "name" ? a.name : a.createdAt.getTime();
  const right = field === "name" ? b.name : b.createdAt.getTime();
  const order = left < right ? -1 : left > right ? 1 : 0;
  return (direction === "asc" ? order : -order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Dates sort in the requested direction with missing dates always last; ties fall back to the villa number.
function compareVillas(a: StoredVilla, b: StoredVilla, { field, direction }: SummarySort): number {
  const sign = direction === "asc" ? 1 : -1;
  if (field === "villaNumber") {
    return sign * a.villaNumber.localeCompare(b.villaNumber);
  }
  const left = a[field];
  const right = b[field];
  if (left === null && right === null) return a.villaNumber.localeCompare(b.villaNumber);
  if (left === null) return 1;
  if (right === null) return -1;
  return sign * (left.getTime() - right.getTime()) || a.villaNumber.localeCompare(b.villaNumber);
}

export class InMemoryContractorsRepository implements ContractorsRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  // The options (a longer timeout, for an import) mean nothing to memory.
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const before = structuredClone({
      contractors: contractorTables.contractors,
      villas: contractorTables.villas,
      batches: importBatchTable.rows,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      contractorTables.contractors = before.contractors;
      contractorTables.villas = before.villas;
      importBatchTable.rows = before.batches;
      throw err;
    }
  }

  async list(params: {
    search?: string | undefined;
    status?: PartyStatusValue | undefined;
    sort: ContractorSort;
    skip: number;
    take: number;
  }) {
    const needle = params.search?.toLowerCase();
    const matching = contractorTables.contractors
      .filter((c) => !params.status || c.status === params.status)
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          c.phone.toLowerCase().includes(needle) ||
          (c.email ?? "").includes(needle),
      )
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async options() {
    return contractorTables.contractors
      .filter((c) => c.status === "ACTIVE")
      .sort((a, b) => compare(a, b, { field: "name", direction: "asc" }))
      .slice(0, MAX_OPTIONS)
      .map((c) => ({ id: c.id, name: c.name, extra: "must not leak" }));
  }

  async findById(id: string): Promise<ContractorRow | null> {
    const contractor = contractorTables.contractors.find((candidate) => candidate.id === id);
    return contractor ? toRow(contractor) : null;
  }

  async create(data: {
    name: string;
    phone: string;
    email: string | null;
    status: PartyStatusValue;
  }): Promise<ContractorRow> {
    const now = new Date();
    return toRow(addContractor({ ...data, createdAt: now, updatedAt: now }));
  }

  async findByNormalizedNames(names: readonly string[]): Promise<{ name: string; phone: string }[]> {
    const wanted = new Set(names);
    return contractorTables.contractors
      .filter((c) => wanted.has(c.name.trim().replace(/\s+/g, " ").toLowerCase()))
      .map((c) => ({ name: c.name, phone: c.phone }));
  }

  async createMany(
    rows: readonly { name: string; phone: string; email: string | null; status: PartyStatusValue }[],
  ): Promise<string[]> {
    const now = new Date();
    return rows.map((row) => addContractor({ ...row, createdAt: now, updatedAt: now }).id);
  }

  async lockVersion(id: string): Promise<number | null> {
    return contractorTables.contractors.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async update(
    id: string,
    version: number,
    data: { name?: string; phone?: string; email?: string | null; status?: PartyStatusValue },
  ): Promise<ContractorRow | null> {
    this.applyRaceOfRemoval(id);
    const contractor = contractorTables.contractors.find((candidate) => candidate.id === id);
    if (!contractor) {
      throw prismaError("P2025");
    }
    if (contractor.version !== version) {
      return null;
    }
    Object.assign(contractor, data, { updatedAt: new Date(), version: contractor.version + 1 });
    return toRow(contractor);
  }

  async delete(id: string, version: number): Promise<boolean> {
    this.applyRaceOfRemoval(id);
    const contractor = contractorTables.contractors.find((candidate) => candidate.id === id);
    if (!contractor) {
      throw prismaError("P2025");
    }
    if (contractor.version !== version) {
      return false;
    }
    if (contractorTables.linkVillaBeforeDelete) {
      addVilla({ contractorId: id });
    }
    // The foreign keys from Villa, WorkItem, DailySmallWork, DailyReport and DailyLabour (all onDelete: Restrict).
    if (linksOf(id) > 0) {
      throw prismaError("P2003");
    }
    contractorTables.contractors = contractorTables.contractors.filter((candidate) => candidate.id !== id);
    return true;
  }

  async countLinks(contractorId: string): Promise<number> {
    return linksOf(contractorId);
  }

  async figures(
    contractorId: string,
    sections: readonly SummarySection[],
    today: Date,
    window: AlertWindow,
  ): Promise<Partial<ContractorFigures>> {
    const figures: Partial<ContractorFigures> = {};
    const day = today.toISOString().slice(0, 10);
    const last = (dates: Date[]): Date | null =>
      dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));
    for (const section of sections) {
      if (section === "openWorks") {
        const mine = workItemTables.items.filter((item) => item.contractorId === contractorId);
        const of = (status: string): number => mine.filter((item) => item.status === status).length;
        figures.openWorks = {
          total: mine.length,
          notStarted: of("NOT_STARTED"),
          inProgress: of("IN_PROGRESS"),
          delayed: of("DELAYED"),
          done: of("DONE"),
          overdue: mine.filter(
            (item) => item.endDate !== null && item.status !== "DONE" && dayOf(item.endDate) < day,
          ).length,
        };
      } else if (section === "smallWorks") {
        const mine = smallWorkTables.works.filter((work) => work.contractorId === contractorId);
        const pending = mine.filter((work) => work.status === "PENDING");
        figures.smallWorks = {
          total: mine.length,
          pending: pending.length,
          done: mine.length - pending.length,
          overdue: pending.filter((work) => dayOf(work.endDate) < window.today).length,
          dueSoon: pending.filter(
            (work) => dayOf(work.endDate) >= window.today && dayOf(work.endDate) < window.horizon,
          ).length,
        };
      } else if (section === "dailyReports") {
        const mine = dailyReportTables.reports.filter((report) => report.contractorId === contractorId);
        figures.dailyReports = { count: mine.length, lastReportDate: last(mine.map((r) => r.reportDate)) };
      } else {
        const mine = dailyLabourTables.rows.filter((row) => row.contractorId === contractorId);
        figures.labour = {
          entries: mine.length,
          totalLabour: mine.reduce((sum, row) => sum + row.labourCount, 0),
          lastLabourDate: last(mine.map((row) => row.labourDate)),
        };
      }
    }
    return figures;
  }

  async listVillas(params: {
    contractorId: string;
    sort: SummarySort;
    skip: number;
    take: number;
  }): Promise<{ rows: ContractorVillaRow[]; total: number }> {
    const matching = contractorTables.villas
      .filter((villa) => villa.contractorId === params.contractorId)
      .sort((a, b) => compareVillas(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map((villa) => ({
        id: villa.id,
        villaNumber: villa.villaNumber,
        area: { name: villa.area },
        block: villa.block,
        plot: villa.plot,
        startDate: villa.startDate,
        targetDate: villa.targetDate,
      })),
      total: matching.length,
    };
  }

  private applyRaceOfRemoval(id: string): void {
    if (contractorTables.removeBeforeWrite) {
      contractorTables.contractors = contractorTables.contractors.filter((candidate) => candidate.id !== id);
    }
  }
}
