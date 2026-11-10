import { randomUUID } from "node:crypto";
import {
  PRIORITIES,
  WORK_STATUSES,
  type OpenWorkFilters,
  type OpenWorkSort,
} from "../../../src/modules/open-works/dto/open-works.dto.js";
import type {
  Db,
  ImportContractor,
  ImportElecPhase,
  ImportVilla,
  NewOpenWork,
  OpenWorkPatch,
  OpenWorkRow,
  OpenWorksRepository,
} from "../../../src/modules/open-works/repository/open-works.repository.js";
// The same key as the real repository's villaPhaseKey. Not imported: the tests mock that module with this one, so a value
// import of it from here would make the two wait for each other forever.
const villaPhaseKey = (villaId: string, elecPhaseId: string): string => `${villaId}:${elecPhaseId}`;
import type { ElecPhaseStatusValue } from "../../../src/modules/elec-phases/dto/elec-phases.dto.js";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addPhase, phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { workItemTables, type StoredWorkItem } from "./work-item-tables.js";

export { workItemTables, type StoredWorkItem } from "./work-item-tables.js";

export const VILLA_FK = "WorkItem_villaId_fkey";
export const PHASE_FK = "WorkItem_elecPhaseId_fkey";
export const CONTRACTOR_FK = "WorkItem_contractorId_fkey";

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.
const foreignKeyError = (constraint: string): Error =>
  Object.assign(new Error("Prisma P2003"), {
    code: "P2003",
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

// Race switches of the open works: each runs once, when the next transaction starts, to do what another request would
// do between the service's checks and its write.
export const openWorkRaces = {
  beforeWrite: null as (() => void) | null,
  // Runs once, when the import locks its villas: after the file was checked and before the rows are written.
  beforeImportLock: null as (() => void) | null,
  reset(): void {
    this.beforeWrite = null;
    this.beforeImportLock = null;
  },
};

// The phase an item gets when the test names none: the first one there is, or one made for the purpose.
function defaultPhaseId(): string {
  return (phaseTables.phases[0] ?? addPhase({ name: "Default phase" })).id;
}

// An item as the table holds it. The villa, phase and contractor must exist when the test reads it back as a row.
export function addWorkItem(overrides: Partial<StoredWorkItem> & { villaId: string }): StoredWorkItem {
  const now = new Date();
  const item: StoredWorkItem = {
    id: randomUUID(),
    elecPhaseId: overrides.elecPhaseId ?? defaultPhaseId(),
    status: "NOT_STARTED",
    priority: "MEDIUM",
    progress: 0,
    contractorId: null,
    startDate: null,
    endDate: null,
    source: "MANUAL",
    version: 1,
    createdById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  workItemTables.items.push(item);
  return item;
}

function toRow(item: StoredWorkItem): OpenWorkRow {
  const villa = villaTables.villas.find((v) => v.id === item.villaId);
  if (!villa) throw new Error("the item's villa is missing");
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  const phase = phaseTables.phases.find((p) => p.id === item.elecPhaseId);
  if (!phase) throw new Error("the item's phase is missing");
  const contractor = item.contractorId
    ? contractorTables.contractors.find((c) => c.id === item.contractorId)
    : undefined;
  const creator = item.createdById ? store.users.find((u) => u.id === item.createdById) : undefined;
  return {
    id: item.id,
    elecPhaseId: item.elecPhaseId,
    status: item.status,
    priority: item.priority,
    progress: item.progress,
    contractorId: item.contractorId,
    startDate: item.startDate,
    endDate: item.endDate,
    source: item.source,
    version: item.version,
    createdById: item.createdById,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    villa: {
      id: villa.id,
      villaNumber: villa.villaNumber,
      block: villa.block,
      plot: villa.plot,
      area: { name: area?.name ?? "" },
    },
    elecPhase: { id: phase.id, name: phase.name },
    contractor: contractor ? { id: contractor.id, name: contractor.name } : null,
    createdBy: creator ? { id: creator.id, name: creator.name } : null,
  };
}

const collator = new Intl.Collator("en", { numeric: true });
const natural = (a: string, b: string): number => collator.compare(a, b);
const byId = (a: StoredWorkItem, b: StoredWorkItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

function matches(item: StoredWorkItem, filters: OpenWorkFilters, today: Date): boolean {
  const late = item.endDate !== null && item.endDate < today && item.status !== "DONE";
  const needle = filters.search?.toLowerCase();
  const villa = villaTables.villas.find((v) => v.id === item.villaId);
  const phase = phaseTables.phases.find((p) => p.id === item.elecPhaseId);
  const contractor = contractorTables.contractors.find((c) => c.id === item.contractorId);
  return (
    (!filters.villaId || item.villaId === filters.villaId) &&
    (!filters.elecPhaseId || item.elecPhaseId === filters.elecPhaseId) &&
    (!filters.status || item.status === filters.status) &&
    (!filters.priority || item.priority === filters.priority) &&
    (!filters.contractorId || item.contractorId === filters.contractorId) &&
    (!filters.startFrom || (item.startDate !== null && dayOf(item.startDate) >= dayOf(filters.startFrom))) &&
    (!filters.startTo || (item.startDate !== null && dayOf(item.startDate) <= dayOf(filters.startTo))) &&
    (!filters.endFrom || (item.endDate !== null && dayOf(item.endDate) >= dayOf(filters.endFrom))) &&
    (!filters.endTo || (item.endDate !== null && dayOf(item.endDate) <= dayOf(filters.endTo))) &&
    (filters.overdue === undefined || late === filters.overdue) &&
    (filters.done === undefined || (item.status === "DONE") === filters.done) &&
    (!needle ||
      [villa?.villaNumber ?? "", phase?.name ?? "", contractor?.name ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ))
  );
}

// The sort keys of the items of the list being sorted, worked out once per item (a comparator that looks the villa, area and phase up
// on every comparison made the 10,000-row export test take over a minute). Only set while a list sorts.
let keyCache: Map<string, string[]> | null = null;

function locationKey(item: StoredWorkItem): string[] {
  const cached = keyCache?.get(item.id);
  if (cached) return cached;
  const key = buildLocationKey(item);
  keyCache?.set(item.id, key);
  return key;
}

function buildLocationKey(item: StoredWorkItem): string[] {
  const villa = villaTables.villas.find((v) => v.id === item.villaId)!;
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  const phase = phaseTables.phases.find((p) => p.id === item.elecPhaseId);
  const order = String(phase?.sortOrder ?? 0).padStart(9, "0");
  return [area?.name ?? "", area?.city ?? "", villa.areaId, villa.block, villa.plot, order];
}

function compare(a: StoredWorkItem, b: StoredWorkItem, { field, direction }: OpenWorkSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const dates = (left: Date | null, right: Date | null): number => {
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1; // NULLS LAST either way
    return (left.getTime() - right.getTime()) * sign;
  };
  switch (field) {
    case "location": {
      const left = locationKey(a);
      const right = locationKey(b);
      for (let i = 0; i < left.length; i += 1) {
        // The phase's order is always ascending; the rest follow the direction (like the SQL).
        const order = natural(left[i]!, right[i]!);
        if (order !== 0) return i === left.length - 1 ? order : order * sign;
      }
      return byId(a, b);
    }
    case "elecPhaseName": {
      const left = phaseTables.phases.find((p) => p.id === a.elecPhaseId)?.name ?? "";
      const right = phaseTables.phases.find((p) => p.id === b.elecPhaseId)?.name ?? "";
      return natural(left, right) * sign || byId(a, b);
    }
    case "status":
      return (WORK_STATUSES.indexOf(a.status) - WORK_STATUSES.indexOf(b.status)) * sign || byId(a, b);
    case "priority":
      return (PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)) * sign || byId(a, b);
    case "progress":
      return (a.progress - b.progress) * sign || byId(a, b);
    case "startDate":
      return dates(a.startDate, b.startDate) || byId(a, b);
    case "endDate":
      return dates(a.endDate, b.endDate) || byId(a, b);
  }
}

// Plain-memory stand-in for the open works' queries. Villas, phases, contractors and users are read from the other
// modules' fakes, so an item can only point at ones that exist, as the foreign keys demand.
export class InMemoryOpenWorksRepository implements OpenWorksRepository {
  // Transactions take turns, as they would behind the row locks (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const race = openWorkRaces.beforeWrite;
    openWorkRaces.beforeWrite = null;
    race?.();
    const before = structuredClone(workItemTables.items);
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      workItemTables.items = before;
      throw err;
    }
  }

  async list(params: {
    filters: OpenWorkFilters;
    sort: OpenWorkSort;
    today: Date;
    skip: number;
    take: number;
  }) {
    const filtered = workItemTables.items.filter((item) => matches(item, params.filters, params.today));
    keyCache = new Map();
    let matching: StoredWorkItem[];
    try {
      matching = filtered.sort((a, b) => compare(a, b, params.sort));
    } finally {
      keyCache = null;
    }
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<OpenWorkRow | null> {
    const item = workItemTables.items.find((candidate) => candidate.id === id);
    return item ? toRow(item) : null;
  }

  async findVillaId(id: string): Promise<string | null> {
    return workItemTables.items.find((candidate) => candidate.id === id)?.villaId ?? null;
  }

  async lockVillaShared(villaId: string): Promise<{ contractorId: string | null } | null> {
    const villa = villaTables.villas.find((candidate) => candidate.id === villaId);
    return villa ? { contractorId: villa.contractorId } : null;
  }

  async lockVersion(id: string): Promise<number | null> {
    return workItemTables.items.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async create(data: NewOpenWork): Promise<OpenWorkRow> {
    if (!villaTables.villas.some((v) => v.id === data.villaId)) throw foreignKeyError(VILLA_FK);
    if (!phaseTables.phases.some((p) => p.id === data.elecPhaseId)) {
      throw foreignKeyError(PHASE_FK);
    }
    if (data.contractorId && !contractorTables.contractors.some((c) => c.id === data.contractorId)) {
      throw foreignKeyError(CONTRACTOR_FK);
    }
    return toRow(addWorkItem({ ...data, source: "MANUAL" }));
  }

  async update(id: string, version: number, patch: OpenWorkPatch): Promise<OpenWorkRow | null> {
    const item = workItemTables.items.find((candidate) => candidate.id === id);
    if (!item || item.version !== version) return null;
    if (patch.elecPhaseId && !phaseTables.phases.some((p) => p.id === patch.elecPhaseId)) {
      throw foreignKeyError(PHASE_FK);
    }
    Object.assign(item, patch, { version: item.version + 1, updatedAt: new Date() });
    return toRow(item);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const item = workItemTables.items.find((candidate) => candidate.id === id);
    if (!item) throw missingRowError();
    if (item.version !== version) return false;
    workItemTables.items = workItemTables.items.filter((candidate) => candidate.id !== id);
    return true;
  }

  async contractorStatus(id: string): Promise<PartyStatusValue | null> {
    return contractorTables.contractors.find((c) => c.id === id)?.status ?? null;
  }

  async elecPhaseStatus(id: string): Promise<ElecPhaseStatusValue | null> {
    return phaseTables.phases.find((p) => p.id === id)?.status ?? null;
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

  async importElecPhases(): Promise<ImportElecPhase[]> {
    return [...phaseTables.phases]
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
      .map((p) => ({ id: p.id, name: p.name, status: p.status }));
  }

  async lockElecPhasesShared(phaseIds: readonly string[]): Promise<Map<string, ElecPhaseStatusValue>> {
    return new Map(
      phaseTables.phases.filter((p) => phaseIds.includes(p.id)).map((p) => [p.id, p.status] as const),
    );
  }

  async lockVillasShared(villaIds: readonly string[]): Promise<Map<string, string | null>> {
    const race = openWorkRaces.beforeImportLock;
    openWorkRaces.beforeImportLock = null;
    race?.();
    return new Map(
      villaTables.villas.filter((v) => villaIds.includes(v.id)).map((v) => [v.id, v.contractorId] as const),
    );
  }

  async createMany(rows: readonly NewOpenWork[]): Promise<string[]> {
    for (const row of rows) {
      if (!villaTables.villas.some((v) => v.id === row.villaId)) throw foreignKeyError(VILLA_FK);
      if (!phaseTables.phases.some((p) => p.id === row.elecPhaseId)) throw foreignKeyError(PHASE_FK);
    }
    return rows.map((row) => addWorkItem({ ...row, source: "MANUAL" }).id);
  }

  // ---- one open work per villa and electrical phase ----

  // The transaction lock of a villa and phase: one request at a time in memory, so there is nothing to wait for.
  async lockVillaPhase(): Promise<void> {}

  async findItemForPhase(
    villaId: string,
    elecPhaseId: string,
    exceptId: string | undefined,
  ): Promise<{ id: string } | null> {
    const item = workItemTables.items.find(
      (candidate) =>
        candidate.villaId === villaId && candidate.elecPhaseId === elecPhaseId && candidate.id !== exceptId,
    );
    return item ? { id: item.id } : null;
  }

  async takenVillaPhases(villaIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      workItemTables.items
        .filter((item) => villaIds.includes(item.villaId))
        .map((item) => villaPhaseKey(item.villaId, item.elecPhaseId)),
    );
  }
}
