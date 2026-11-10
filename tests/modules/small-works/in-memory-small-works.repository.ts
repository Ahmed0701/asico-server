import { randomUUID } from "node:crypto";
import type { AlertWindow } from "../../../src/shared/utils/deadline.js";
import type {
  SmallWorkFilters,
  SmallWorkSort,
} from "../../../src/modules/small-works/dto/small-works.dto.js";
import type {
  Db,
  ImportContractorRef,
  ImportVillaRef,
  NewSmallWork,
  SmallWorkPatch,
  SmallWorkRow,
  SmallWorksRepository,
} from "../../../src/modules/small-works/repository/small-works.repository.js";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { smallWorkTables, type StoredSmallWork } from "./small-work-tables.js";

export { smallWorkTables, type StoredSmallWork } from "./small-work-tables.js";

export const VILLA_FK = "DailySmallWork_villaId_fkey";
export const CONTRACTOR_FK = "DailySmallWork_contractorId_fkey";

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.
export const foreignKeyError = (constraint: string): Error =>
  Object.assign(new Error("Prisma P2003"), {
    code: "P2003",
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

// Race switches of the small works: each runs once, when the next transaction starts (or, for the import, when it locks its
// villas), to do what another request would do between the service's checks and its write.
export const smallWorkRaces = {
  beforeWrite: null as (() => void) | null,
  beforeImportLock: null as (() => void) | null,
  reset(): void {
    this.beforeWrite = null;
    this.beforeImportLock = null;
  },
};

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

let counter = 0;
// A small work as the table holds it. The villa must exist when the test reads it back as a row.
export function addSmallWork(
  overrides: Partial<StoredSmallWork> & { villaId: string; contractorId: string },
): StoredSmallWork {
  counter += 1;
  const now = new Date();
  const work: StoredSmallWork = {
    id: randomUUID(),
    startDate: new Date(Date.UTC(2026, 0, 1 + (counter % 28))),
    endDate: new Date(Date.UTC(2026, 0, 1 + (counter % 28))),
    description: `Small work ${counter}`,
    status: "PENDING",
    createdById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  smallWorkTables.works.push(work);
  return work;
}

function toRow(work: StoredSmallWork): SmallWorkRow {
  const villa = villaTables.villas.find((v) => v.id === work.villaId);
  if (!villa) throw new Error("the small work's villa is missing");
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  const contractor = contractorTables.contractors.find((c) => c.id === work.contractorId);
  if (!contractor) throw new Error("the small work's contractor is missing");
  const creator = work.createdById ? store.users.find((u) => u.id === work.createdById) : undefined;
  return {
    id: work.id,
    contractorId: work.contractorId,
    startDate: work.startDate,
    endDate: work.endDate,
    description: work.description,
    status: work.status,
    version: work.version,
    createdById: work.createdById,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
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
const byId = (a: StoredSmallWork, b: StoredSmallWork): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The rule of the overdue and dueSoon filters: two days of the application zone (see shared/utils/deadline.ts).
const isOverdue = (work: StoredSmallWork, { today }: AlertWindow): boolean =>
  work.status === "PENDING" && dayOf(work.endDate) < today;
const isDueSoon = (work: StoredSmallWork, { today, horizon }: AlertWindow): boolean =>
  work.status === "PENDING" && dayOf(work.endDate) >= today && dayOf(work.endDate) < horizon;
const flagMatches = (wanted: boolean | undefined, actual: boolean | undefined): boolean =>
  wanted === undefined || wanted === (actual ?? false);

function matches(work: StoredSmallWork, filters: SmallWorkFilters): boolean {
  const needle = filters.search?.toLowerCase();
  const villa = villaTables.villas.find((v) => v.id === work.villaId);
  const contractor = contractorTables.contractors.find((c) => c.id === work.contractorId);
  return (
    (!filters.villaId || work.villaId === filters.villaId) &&
    (!filters.status || work.status === filters.status) &&
    (!filters.contractorId || work.contractorId === filters.contractorId) &&
    (!filters.startFrom || dayOf(work.startDate) >= dayOf(filters.startFrom)) &&
    (!filters.startTo || dayOf(work.startDate) <= dayOf(filters.startTo)) &&
    (!filters.endFrom || dayOf(work.endDate) >= dayOf(filters.endFrom)) &&
    (!filters.endTo || dayOf(work.endDate) <= dayOf(filters.endTo)) &&
    flagMatches(filters.overdue, filters.alert && isOverdue(work, filters.alert)) &&
    flagMatches(filters.dueSoon, filters.alert && isDueSoon(work, filters.alert)) &&
    (!needle ||
      [work.description, contractor?.name ?? "", villa?.villaNumber ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ))
  );
}

function compare(a: StoredSmallWork, b: StoredSmallWork, { field, direction }: SmallWorkSort): number {
  const sign = direction === "asc" ? 1 : -1;
  switch (field) {
    case "startDate":
      return (a.startDate.getTime() - b.startDate.getTime()) * sign || byId(a, b);
    case "endDate":
      return (a.endDate.getTime() - b.endDate.getTime()) * sign || byId(a, b);
    case "villaNumber": {
      const left = villaTables.villas.find((v) => v.id === a.villaId)!.villaNumber;
      const right = villaTables.villas.find((v) => v.id === b.villaId)!.villaNumber;
      return natural(left, right) * sign || b.endDate.getTime() - a.endDate.getTime() || byId(a, b);
    }
    case "contractorName": {
      const left = contractorTables.contractors.find((c) => c.id === a.contractorId)!.name;
      const right = contractorTables.contractors.find((c) => c.id === b.contractorId)!.name;
      return (
        (left < right ? -1 : left > right ? 1 : 0) * sign ||
        b.endDate.getTime() - a.endDate.getTime() ||
        byId(a, b)
      );
    }
    case "status":
      // PENDING comes before DONE in the enum, as it does in the database.
      return (a.status === b.status ? 0 : a.status === "PENDING" ? -1 : 1) * sign || byId(a, b);
    case "createdAt":
      return (a.createdAt.getTime() - b.createdAt.getTime()) * sign || byId(a, b);
  }
}

// Plain-memory stand-in for the small works' queries. Villas and users are read from the other modules' fakes, so a small
// work can only point at a villa that exists, as the foreign key demands.
export class InMemorySmallWorksRepository implements Pick<SmallWorksRepository, keyof SmallWorksRepository> {
  // Transactions take turns, as they would behind the row locks (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const race = smallWorkRaces.beforeWrite;
    smallWorkRaces.beforeWrite = null;
    race?.();
    const before = structuredClone(smallWorkTables.works);
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      smallWorkTables.works = before;
      throw err;
    }
  }

  async list(params: { filters: SmallWorkFilters; sort: SmallWorkSort; skip: number; take: number }) {
    const matching = smallWorkTables.works
      .filter((work) => matches(work, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<SmallWorkRow | null> {
    const work = smallWorkTables.works.find((candidate) => candidate.id === id);
    return work ? toRow(work) : null;
  }

  async findVillaId(id: string): Promise<string | null> {
    return smallWorkTables.works.find((candidate) => candidate.id === id)?.villaId ?? null;
  }

  async lockVillaShared(villaId: string): Promise<boolean> {
    return villaTables.villas.some((candidate) => candidate.id === villaId);
  }

  async lockVersion(id: string): Promise<number | null> {
    return smallWorkTables.works.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async create(data: NewSmallWork): Promise<SmallWorkRow> {
    if (!villaTables.villas.some((v) => v.id === data.villaId)) throw foreignKeyError(VILLA_FK);
    if (!contractorTables.contractors.some((c) => c.id === data.contractorId))
      throw foreignKeyError(CONTRACTOR_FK);
    return toRow(addSmallWork(data));
  }

  async update(id: string, version: number, patch: SmallWorkPatch): Promise<SmallWorkRow | null> {
    const work = smallWorkTables.works.find((candidate) => candidate.id === id);
    if (!work || work.version !== version) return null;
    if (patch.contractorId && !contractorTables.contractors.some((c) => c.id === patch.contractorId)) {
      throw foreignKeyError(CONTRACTOR_FK);
    }
    Object.assign(work, patch, { version: work.version + 1, updatedAt: new Date() });
    return toRow(work);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const work = smallWorkTables.works.find((candidate) => candidate.id === id);
    if (!work) throw missingRowError();
    if (work.version !== version) return false;
    smallWorkTables.works = smallWorkTables.works.filter((candidate) => candidate.id !== id);
    return true;
  }

  // ---- the import's queries ----

  async importVillas(): Promise<ImportVillaRef[]> {
    return villaTables.villas.map((v) => ({ id: v.id, villaNumber: v.villaNumber }));
  }

  async importContractors(): Promise<ImportContractorRef[]> {
    return contractorTables.contractors.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
    }));
  }

  async contractorStatus(id: string): Promise<PartyStatusValue | null> {
    return contractorTables.contractors.find((c) => c.id === id)?.status ?? null;
  }

  async lockContractorsShared(contractorIds: readonly string[]): Promise<Map<string, PartyStatusValue>> {
    return new Map(
      contractorTables.contractors.filter((c) => contractorIds.includes(c.id)).map((c) => [c.id, c.status]),
    );
  }

  async userExists(id: string): Promise<boolean> {
    return store.users.some((user) => user.id === id);
  }

  async lockVillasShared(villaIds: readonly string[]): Promise<Set<string>> {
    const race = smallWorkRaces.beforeImportLock;
    smallWorkRaces.beforeImportLock = null;
    race?.();
    return new Set(villaTables.villas.filter((v) => villaIds.includes(v.id)).map((v) => v.id));
  }

  async createMany(rows: readonly NewSmallWork[]): Promise<string[]> {
    for (const row of rows) {
      if (!villaTables.villas.some((v) => v.id === row.villaId)) throw foreignKeyError(VILLA_FK);
      if (!contractorTables.contractors.some((c) => c.id === row.contractorId))
        throw foreignKeyError(CONTRACTOR_FK);
    }
    return rows.map((row) => addSmallWork(row).id);
  }
}
