import { randomUUID } from "node:crypto";
import {
  type DailyLabourFilters,
  type DailyLabourSort,
} from "../../../src/modules/daily-labour/dto/daily-labour.dto.js";
import type {
  DailyLabourPatch,
  DailyLabourRepository,
  DailyLabourRow,
  Db,
  ImportContractor,
  ImportVilla,
  NewDailyLabour,
} from "../../../src/modules/daily-labour/repository/daily-labour.repository.js";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { dailyLabourTables, type StoredDailyLabour } from "./daily-labour-tables.js";

export { dailyLabourTables, type StoredDailyLabour } from "./daily-labour-tables.js";

export const VILLA_FK = "DailyLabour_villaId_fkey";
export const CONTRACTOR_FK = "DailyLabour_contractorId_fkey";
export const KEY_UNIQUE = "DailyLabour_villaId_contractorId_labourDate_key";

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.
const databaseError = (code: string, constraint: string): Error =>
  Object.assign(new Error(`Prisma ${code}`), {
    code,
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
export const foreignKeyError = (constraint: string): Error => databaseError("P2003", constraint);
export const uniqueError = (constraint: string): Error => databaseError("P2002", constraint);
const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

// Race switches of the daily labour: each runs once, when the next transaction starts, to do what another request would
// do between the service's checks and its write.
export const dailyLabourRaces = {
  beforeWrite: null as (() => void) | null,
  // Runs once, when the import locks its villas: after the file was checked and before the rows are written.
  beforeImportLock: null as (() => void) | null,
  reset(): void {
    this.beforeWrite = null;
    this.beforeImportLock = null;
  },
};

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

let counter = 0;
// A row as the table holds it. The villa and contractor must exist when the test reads it back as a row.
export function addDailyLabour(
  overrides: Partial<StoredDailyLabour> & { villaId: string; contractorId: string },
): StoredDailyLabour {
  counter += 1;
  const now = new Date();
  const row: StoredDailyLabour = {
    id: randomUUID(),
    labourDate: new Date(Date.UTC(2026, 0, 1 + (counter % 28))),
    labourCount: 10,
    notes: null,
    createdById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  dailyLabourTables.rows.push(row);
  return row;
}

function toRow(stored: StoredDailyLabour): DailyLabourRow {
  const villa = villaTables.villas.find((v) => v.id === stored.villaId);
  if (!villa) throw new Error("the row's villa is missing");
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  const contractor = contractorTables.contractors.find((c) => c.id === stored.contractorId);
  if (!contractor) throw new Error("the row's contractor is missing");
  const creator = stored.createdById ? store.users.find((u) => u.id === stored.createdById) : undefined;
  return {
    id: stored.id,
    labourDate: stored.labourDate,
    contractorId: stored.contractorId,
    labourCount: stored.labourCount,
    notes: stored.notes,
    version: stored.version,
    createdById: stored.createdById,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    villa: {
      id: villa.id,
      villaNumber: villa.villaNumber,
      block: villa.block,
      plot: villa.plot,
      area: { name: area?.name ?? "" },
    },
    contractor: { id: contractor.id, name: contractor.name },
    createdBy: creator ? { id: creator.id, name: creator.name } : null,
  };
}

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const byId = (a: StoredDailyLabour, b: StoredDailyLabour): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function matches(row: StoredDailyLabour, filters: DailyLabourFilters): boolean {
  const needle = filters.search?.toLowerCase();
  const villa = villaTables.villas.find((v) => v.id === row.villaId);
  const contractor = contractorTables.contractors.find((c) => c.id === row.contractorId);
  return (
    (!filters.villaId || row.villaId === filters.villaId) &&
    (!filters.contractorId || row.contractorId === filters.contractorId) &&
    (!filters.labourFrom || dayOf(row.labourDate) >= dayOf(filters.labourFrom)) &&
    (!filters.labourTo || dayOf(row.labourDate) <= dayOf(filters.labourTo)) &&
    (!needle ||
      [villa?.villaNumber ?? "", contractor?.name ?? "", row.notes ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ))
  );
}

function compare(a: StoredDailyLabour, b: StoredDailyLabour, { field, direction }: DailyLabourSort): number {
  const sign = direction === "asc" ? 1 : -1;
  switch (field) {
    case "labourDate":
      return (a.labourDate.getTime() - b.labourDate.getTime()) * sign || byId(a, b);
    case "villaNumber": {
      const left = villaTables.villas.find((v) => v.id === a.villaId)!.villaNumber;
      const right = villaTables.villas.find((v) => v.id === b.villaId)!.villaNumber;
      return natural(left, right) * sign || b.labourDate.getTime() - a.labourDate.getTime() || byId(a, b);
    }
    case "contractorName": {
      const left = contractorTables.contractors.find((c) => c.id === a.contractorId)!.name;
      const right = contractorTables.contractors.find((c) => c.id === b.contractorId)!.name;
      return (
        (left < right ? -1 : left > right ? 1 : 0) * sign ||
        b.labourDate.getTime() - a.labourDate.getTime() ||
        byId(a, b)
      );
    }
    case "labourCount":
      return (a.labourCount - b.labourCount) * sign || byId(a, b);
    case "createdAt":
      return (a.createdAt.getTime() - b.createdAt.getTime()) * sign || byId(a, b);
  }
}

// Plain-memory stand-in for the daily labour's queries. Villas, contractors and users are read from the other modules'
// fakes, so a row can only point at ones that exist, as the foreign keys demand. The unique index on (villa, contractor,
// day) is enforced the way the database does.
export class InMemoryDailyLabourRepository implements DailyLabourRepository {
  // Transactions take turns, as they would behind the row locks (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const race = dailyLabourRaces.beforeWrite;
    dailyLabourRaces.beforeWrite = null;
    race?.();
    const before = structuredClone(dailyLabourTables.rows);
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      dailyLabourTables.rows = before;
      throw err;
    }
  }

  async list(params: { filters: DailyLabourFilters; sort: DailyLabourSort; skip: number; take: number }) {
    const matching = dailyLabourTables.rows
      .filter((row) => matches(row, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<DailyLabourRow | null> {
    const row = dailyLabourTables.rows.find((candidate) => candidate.id === id);
    return row ? toRow(row) : null;
  }

  async findVillaId(id: string): Promise<string | null> {
    return dailyLabourTables.rows.find((candidate) => candidate.id === id)?.villaId ?? null;
  }

  async lockVillaShared(villaId: string): Promise<{ contractorId: string | null } | null> {
    const villa = villaTables.villas.find((candidate) => candidate.id === villaId);
    return villa ? { contractorId: villa.contractorId } : null;
  }

  async lockVersion(id: string): Promise<number | null> {
    return dailyLabourTables.rows.find((candidate) => candidate.id === id)?.version ?? null;
  }

  private assertKeyFree(villaId: string, contractorId: string, labourDate: Date, exceptId?: string): void {
    const taken = dailyLabourTables.rows.some(
      (row) =>
        row.id !== exceptId &&
        row.villaId === villaId &&
        row.contractorId === contractorId &&
        dayOf(row.labourDate) === dayOf(labourDate),
    );
    if (taken) throw uniqueError(KEY_UNIQUE);
  }

  async create(data: NewDailyLabour): Promise<DailyLabourRow> {
    if (!villaTables.villas.some((v) => v.id === data.villaId)) throw foreignKeyError(VILLA_FK);
    if (!contractorTables.contractors.some((c) => c.id === data.contractorId)) {
      throw foreignKeyError(CONTRACTOR_FK);
    }
    this.assertKeyFree(data.villaId, data.contractorId, data.labourDate);
    return toRow(addDailyLabour(data));
  }

  async update(id: string, version: number, patch: DailyLabourPatch): Promise<DailyLabourRow | null> {
    const row = dailyLabourTables.rows.find((candidate) => candidate.id === id);
    if (!row || row.version !== version) return null;
    if (patch.contractorId && !contractorTables.contractors.some((c) => c.id === patch.contractorId)) {
      throw foreignKeyError(CONTRACTOR_FK);
    }
    this.assertKeyFree(
      row.villaId,
      patch.contractorId ?? row.contractorId,
      patch.labourDate ?? row.labourDate,
      id,
    );
    Object.assign(row, patch, { version: row.version + 1, updatedAt: new Date() });
    return toRow(row);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const row = dailyLabourTables.rows.find((candidate) => candidate.id === id);
    if (!row) throw missingRowError();
    if (row.version !== version) return false;
    dailyLabourTables.rows = dailyLabourTables.rows.filter((candidate) => candidate.id !== id);
    return true;
  }

  async contractorStatus(id: string): Promise<PartyStatusValue | null> {
    return contractorTables.contractors.find((c) => c.id === id)?.status ?? null;
  }

  // ---- the import's queries ----

  async importVillas(): Promise<ImportVilla[]> {
    return villaTables.villas.map((v) => ({
      id: v.id,
      villaNumber: v.villaNumber,
      contractorId: v.contractorId,
    }));
  }

  async importContractors(): Promise<ImportContractor[]> {
    return contractorTables.contractors.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
    }));
  }

  async existingKeys(
    villaIds: readonly string[],
  ): Promise<{ villaId: string; contractorId: string; labourDate: Date }[]> {
    return dailyLabourTables.rows
      .filter((row) => villaIds.includes(row.villaId))
      .map((row) => ({ villaId: row.villaId, contractorId: row.contractorId, labourDate: row.labourDate }));
  }

  async lockVillasShared(villaIds: readonly string[]): Promise<Map<string, string | null>> {
    const race = dailyLabourRaces.beforeImportLock;
    dailyLabourRaces.beforeImportLock = null;
    race?.();
    return new Map(
      villaTables.villas.filter((v) => villaIds.includes(v.id)).map((v) => [v.id, v.contractorId] as const),
    );
  }

  async createMany(rows: readonly NewDailyLabour[]): Promise<string[]> {
    for (const row of rows) {
      if (!villaTables.villas.some((v) => v.id === row.villaId)) throw foreignKeyError(VILLA_FK);
    }
    return rows.map((row) => {
      this.assertKeyFree(row.villaId, row.contractorId, row.labourDate);
      return addDailyLabour(row).id;
    });
  }
}
