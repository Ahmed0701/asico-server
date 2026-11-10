import type { MewStateValue } from "../../../src/shared/constants/enums.js";
import { openWorkProgressOf } from "../open-works/work-item-tables.js";
import { doneRatioOf, villaProgressOf } from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";
import { randomUUID } from "node:crypto";
import {
  MAX_BUDGET_MINOR,
  MAX_FILTER_VALUES,
  MAX_OPTIONS,
  type VillaFilters,
  type VillaSort,
} from "../../../src/modules/villas/dto/villas.dto.js";
import type {
  Db,
  ImportRefs,
  InspectionMark,
  LockedRefs,
  MarkRow,
  MewStatesPatch,
  MewStatesRow,
  VillaMark,
  NewVilla,
  ProgressTotals,
  VillaDetailRow,
  VillaListRow,
  VillaPatch,
  VillaSnapshotRow,
  VillasRepository,
} from "../../../src/modules/villas/repository/villas.repository.js";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import { addArea, areaTables } from "../areas/in-memory-areas.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { electricalTables } from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { siteReportTables } from "../site-reports/site-report-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { progressTables } from "../villa-progress/progress-tables.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

export type StoredVilla = {
  id: string;
  villaNumber: string;
  ownerName: string | null;
  villaType: "ACICO_SYSTEM" | "CONVENTIONAL" | null;
  areaId: string;
  block: string;
  plot: string;
  civilEngineerId: string;
  electricalEngineerId: string | null;
  contractorId: string | null;
  // Calendar days: a Date at 00:00 UTC.
  startDate: Date | null;
  targetDate: Date | null;
  budgetMinor: number | null;
  currency: string | null;
  createdById: string;
  // The MEW follow-up mark. The user can be missing from the users while the time stays (SET NULL in the database).
  mewFollowUpAt: Date | null;
  mewFollowUpById: string | null;
  // The MEW inspection mark, and the villa's MEW states.
  mewInspectionAt: Date | null;
  mewInspectionById: string | null;
  mewInspectionPassedAt: Date | null;
  mewInspectionPassedById: string | null;
  mewAcState: MewStateValue;
  mewElecState: MewStateValue;
  mewInspectionDate: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type StoredDocument = {
  id: string;
  villaId: string;
  storageKey: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedById: string;
  createdAt: Date;
};

// Plain-memory stand-in for Villa and VillaDocument. Areas, engineers and contractors are read
// from the other modules' fakes, so a villa can only point at ones that exist, as the foreign keys demand.
export const villaTables = {
  villas: [] as StoredVilla[],
  documents: [] as StoredDocument[],
  // Run once, when the next transaction starts: tests use it to do what another request would do between
  // the service's checks and its write.
  beforeWrite: null as (() => void) | null,

  reset(): void {
    this.villas = [];
    this.documents = [];
    this.beforeWrite = null;
    areaTables.reset();
    progressTables.reset();
    workItemTables.reset();
    dailyReportTables.reset();
    smallWorkTables.reset();
    siteReportTables.reset();
    dailyLabourTables.reset();
  },
};

// The areas fake counts the villas of an area from these rows.
areaTables.villaCountOf = (areaId) => villaTables.villas.filter((p) => p.areaId === areaId).length;
// The progress rows' table asks which villas exist.
progressTables.villaIds = () => villaTables.villas.map((v) => v.id);

// Errors shaped like the real ones (see the probe): the constraint name sits under meta.driverAdapterError.cause.
const databaseError = (code: string, constraint: string): Error =>
  Object.assign(new Error(`Prisma ${code}`), {
    code,
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });
export const uniqueError = (constraint: string): Error => databaseError("P2002", constraint);
export const foreignKeyError = (constraint: string): Error => databaseError("P2003", constraint);
export const missingRowError = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });

export const NUMBER_CONSTRAINT = "Villa_villaNumber_key";
export const PLOT_CONSTRAINT = "Villa_areaId_block_plot_key";
export const AREA_FK = "Villa_areaId_fkey";
export const ENGINEER_FK = "Villa_civilEngineerId_fkey";
export const ELECTRICAL_FK = "Villa_electricalEngineerId_fkey";
export const CONTRACTOR_FK = "Villa_contractorId_fkey";

// The area with this name, created (in Cairo) the first time it is asked for.
export function areaNamed(name: string): string {
  const found = areaTables.areas.find((a) => a.name === name);
  return (found ?? addArea({ name })).id;
}

// A day as the DATE column holds it: midnight UTC.
export const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

let counter = 0;
// `area` is a shortcut for the name of the area: it is looked up (or created) and its id stored as `areaId`.
export function addVilla({ area, ...overrides }: Partial<StoredVilla> & { area?: string } = {}): StoredVilla {
  counter += 1;
  const now = new Date();
  const villa: StoredVilla = {
    id: randomUUID(),
    villaNumber: `P-${String(counter).padStart(4, "0")}`,
    ownerName: null,
    villaType: null,
    areaId: overrides.areaId ?? areaNamed(area ?? "New Cairo"),
    block: "B1",
    plot: String(counter),
    civilEngineerId: engineerTables.engineers[0]?.id ?? randomUUID(),
    electricalEngineerId: null,
    contractorId: null,
    startDate: null,
    targetDate: null,
    budgetMinor: null,
    currency: null,
    createdById: store.users[0]?.id ?? randomUUID(),
    mewFollowUpAt: null,
    mewFollowUpById: null,
    mewInspectionAt: null,
    mewInspectionById: null,
    mewInspectionPassedAt: null,
    mewInspectionPassedById: null,
    mewAcState: "NOT_SUBMITTED",
    mewElecState: "NOT_SUBMITTED",
    mewInspectionDate: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  villaTables.villas.push(villa);
  return villa;
}

function runBeforeWrite(): void {
  const hook = villaTables.beforeWrite;
  villaTables.beforeWrite = null;
  hook?.();
}

const contractorOf = (villa: StoredVilla) =>
  contractorTables.contractors.find((c) => c.id === villa.contractorId);
const civilEngineerOf = (villa: StoredVilla) =>
  engineerTables.engineers.find((e) => e.id === villa.civilEngineerId);
const electricalEngineerOf = (villa: StoredVilla) =>
  electricalTables.engineers.find((e) => e.id === villa.electricalEngineerId);

// The user with this id, if that user still exists (a marker can be deleted while the mark stays).
function userRef(id: string | null): { id: string; name: string } | null {
  const user = store.users.find((u) => u.id === id);
  return user ? { id: user.id, name: user.name } : null;
}

const areaNameOf = (areaId: string): string => areaTables.areas.find((a) => a.id === areaId)?.name ?? "";
const areaCityOf = (areaId: string): string => areaTables.areas.find((a) => a.id === areaId)?.city ?? "";

// The active phases in display order, each with the villa's progress in it (no row reads as 0, version 1).
function activePhasesOf(villaId: string) {
  return [...phaseTables.phases]
    .filter((phase) => phase.status === "ACTIVE")
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((phase) => {
      const row = progressTables.find(villaId, phase.id);
      return {
        elecPhaseId: phase.id,
        name: phase.name,
        sortOrder: phase.sortOrder,
        progressRatio: phase.progressRatio,
        // Read from the villa's open works, like PHASE_PROGRESS.
        progress: openWorkProgressOf(villaId, phase.id),
        version: row?.version ?? 1,
      };
    });
}

function totalsOf(villaId: string): ProgressTotals {
  const phases = activePhasesOf(villaId);
  // Like PHASE_DONE_RATIO: a phase adds its ratio once the villa's open work for it is done.
  return {
    doneRatio: phases.reduce((sum, p) => sum + doneRatioOf(p), 0),
    phaseCount: phases.length,
  };
}

function toListRow(villa: StoredVilla): VillaListRow {
  const engineer = civilEngineerOf(villa);
  const electrical = electricalEngineerOf(villa);
  const contractor = contractorOf(villa);
  return {
    id: villa.id,
    villaNumber: villa.villaNumber,
    ownerName: villa.ownerName,
    villaType: villa.villaType,
    areaId: villa.areaId,
    area: { name: areaNameOf(villa.areaId) },
    block: villa.block,
    plot: villa.plot,
    startDate: villa.startDate,
    targetDate: villa.targetDate,
    budgetMinor: villa.budgetMinor === null ? null : BigInt(villa.budgetMinor),
    currency: villa.currency,
    mewFollowUpAt: villa.mewFollowUpAt,
    mewFollowUpBy: userRef(villa.mewFollowUpById),
    mewInspectionAt: villa.mewInspectionAt,
    mewInspectionBy: userRef(villa.mewInspectionById),
    mewInspectionPassedAt: villa.mewInspectionPassedAt,
    mewInspectionPassedBy: userRef(villa.mewInspectionPassedById),
    mewAcState: villa.mewAcState,
    mewElecState: villa.mewElecState,
    mewInspectionDate: villa.mewInspectionDate,
    version: villa.version,
    createdAt: villa.createdAt,
    updatedAt: villa.updatedAt,
    civilEngineer: { id: villa.civilEngineerId, name: engineer?.name ?? "" },
    electricalEngineer: electrical ? { id: electrical.id, name: electrical.name } : null,
    contractor: contractor ? { id: contractor.id, name: contractor.name } : null,
    ...totalsOf(villa.id),
  };
}

function toDetailRow(villa: StoredVilla): VillaDetailRow {
  const engineer = civilEngineerOf(villa);
  const electrical = electricalEngineerOf(villa);
  const contractor = contractorOf(villa);
  const creator = store.users.find((u) => u.id === villa.createdById);
  return {
    ...toListRow(villa),
    civilEngineer: { id: villa.civilEngineerId, name: engineer?.name ?? "", phone: engineer?.phone ?? "" },
    electricalEngineer: electrical
      ? { id: electrical.id, name: electrical.name, phone: electrical.phone }
      : null,
    contractor: contractor ? { id: contractor.id, name: contractor.name, phone: contractor.phone } : null,
    createdBy: { id: villa.createdById, name: creator?.name ?? "" },
    phases: activePhasesOf(villa.id),
  };
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The search looks in exactly four places.
function searchHit(villa: StoredVilla, needle: string): boolean {
  return [
    villa.villaNumber,
    villa.ownerName ?? "",
    civilEngineerOf(villa)?.name ?? "",
    electricalEngineerOf(villa)?.name ?? "",
  ].some((value) => value.toLowerCase().includes(needle));
}

function matches(villa: StoredVilla, f: VillaFilters): boolean {
  const needle = f.search?.toLowerCase();
  const inRange = (value: Date | null, from?: Date, to?: Date): boolean =>
    (!from && !to) || (value !== null && (!from || value >= from) && (!to || value <= to));
  return (
    (!f.area || eq(areaNameOf(villa.areaId), f.area)) &&
    (!f.areaId || villa.areaId === f.areaId) &&
    (!f.block || eq(villa.block, f.block)) &&
    (!f.plot || eq(villa.plot, f.plot)) &&
    (!f.civilEngineerId || villa.civilEngineerId === f.civilEngineerId) &&
    (!f.electricalEngineerId || villa.electricalEngineerId === f.electricalEngineerId) &&
    (!f.contractorId || villa.contractorId === f.contractorId) &&
    (f.mewFollowUp === undefined || (villa.mewFollowUpAt !== null) === f.mewFollowUp) &&
    (f.mewInspection === undefined || (villa.mewInspectionAt !== null) === f.mewInspection) &&
    (f.mewInspectionPassed === undefined ||
      (villa.mewInspectionPassedAt !== null) === f.mewInspectionPassed) &&
    (!f.villaType || villa.villaType === f.villaType) &&
    inRange(villa.startDate, f.startFrom, f.startTo) &&
    inRange(villa.targetDate, f.targetFrom, f.targetTo) &&
    (!needle || searchHit(villa, needle))
  );
}

// ICU "en" with numeric ordering is what the database's asico_natural collation is.
const natural = new Intl.Collator("en", { numeric: true });

function compare(a: StoredVilla, b: StoredVilla, { field, direction }: VillaSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const tie = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  switch (field) {
    case "location":
      return (
        sign *
          (natural.compare(areaNameOf(a.areaId), areaNameOf(b.areaId)) ||
            natural.compare(areaCityOf(a.areaId), areaCityOf(b.areaId)) ||
            (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0) ||
            natural.compare(a.block, b.block) ||
            natural.compare(a.plot, b.plot)) || tie
      );
    case "villaNumber":
      return sign * natural.compare(a.villaNumber, b.villaNumber) || tie;
    case "createdAt":
      return sign * (a.createdAt.getTime() - b.createdAt.getTime()) || tie;
    case "progress": {
      // The overall progress, as the database sorts it.
      const average = (villa: StoredVilla): number => villaProgressOf(totalsOf(villa.id).doneRatio);
      return sign * (average(a) - average(b)) || tie;
    }
    case "targetDate": {
      if (a.targetDate === null && b.targetDate === null) return tie;
      if (a.targetDate === null) return 1;
      if (b.targetDate === null) return -1;
      return sign * (a.targetDate.getTime() - b.targetDate.getTime()) || tie;
    }
  }
}

function assertUnique(
  candidate: Pick<StoredVilla, "villaNumber" | "areaId" | "block" | "plot">,
  ignoreId?: string,
): void {
  const others = villaTables.villas.filter((p) => p.id !== ignoreId);
  if (others.some((p) => p.villaNumber === candidate.villaNumber)) throw uniqueError(NUMBER_CONSTRAINT);
  if (
    others.some(
      (p) => p.areaId === candidate.areaId && p.block === candidate.block && p.plot === candidate.plot,
    )
  ) {
    throw uniqueError(PLOT_CONSTRAINT);
  }
}

// The database's CHECK constraints. The service validates first, so reaching one is a bug in the service.
function assertChecks(v: Pick<StoredVilla, "startDate" | "targetDate" | "budgetMinor" | "currency">): void {
  if (v.startDate && v.targetDate && v.targetDate < v.startDate) {
    throw Object.assign(new Error("CHECK Villa_dates_check"), { code: "23514" });
  }
  const pairOk = (v.budgetMinor === null) === (v.currency === null);
  const rangeOk = v.budgetMinor === null || (v.budgetMinor >= 0 && v.budgetMinor <= MAX_BUDGET_MINOR);
  const codeOk = v.currency === null || /^[A-Z]{3}$/.test(v.currency);
  if (!pairOk || !rangeOk || !codeOk) {
    throw Object.assign(new Error("CHECK Villa_budget_check"), { code: "23514" });
  }
}

function assertForeignKeys(v: Partial<StoredVilla>): void {
  if (v.areaId !== undefined && !areaTables.areas.some((a) => a.id === v.areaId))
    throw foreignKeyError(AREA_FK);
  if (v.civilEngineerId !== undefined && !engineerTables.engineers.some((e) => e.id === v.civilEngineerId)) {
    throw foreignKeyError(ENGINEER_FK);
  }
  if (
    v.electricalEngineerId !== undefined &&
    v.electricalEngineerId !== null &&
    !electricalTables.engineers.some((e) => e.id === v.electricalEngineerId)
  ) {
    throw foreignKeyError(ELECTRICAL_FK);
  }
  if (
    v.contractorId !== undefined &&
    v.contractorId !== null &&
    !contractorTables.contractors.some((c) => c.id === v.contractorId)
  ) {
    throw foreignKeyError(CONTRACTOR_FK);
  }
}

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

export class InMemoryVillasRepository implements VillasRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  // (The time allowance the real one takes is of no use to a fake.)
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    // What another request did since the service's checks. It is committed, so a rollback here must not undo it.
    runBeforeWrite();
    const before = structuredClone({
      villas: villaTables.villas,
      documents: villaTables.documents,
      progress: progressTables.rows,
      items: workItemTables.items,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      villaTables.villas = before.villas;
      villaTables.documents = before.documents;
      progressTables.rows = before.progress;
      workItemTables.items = before.items;
      throw err;
    }
  }

  async list(params: { filters: VillaFilters; sort: VillaSort; skip: number; take: number }) {
    const matching = villaTables.villas
      .filter((p) => matches(p, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toListRow),
      total: matching.length,
    };
  }

  async progressTotals(villaIds: string[]): Promise<Map<string, ProgressTotals>> {
    return new Map(villaIds.map((id) => [id, totalsOf(id)]));
  }

  async lockPhaseSet(): Promise<void> {
    // The transaction lock already makes transactions take turns.
  }

  async insertProgressRows(villaId: string): Promise<void> {
    progressTables.insertMissing(progressTables.phaseIds().map((elecPhaseId) => ({ villaId, elecPhaseId })));
  }

  async importAreas() {
    return areaTables.areas.map((area) => ({ id: area.id, name: area.name, city: area.city }));
  }

  async importCivilEngineers() {
    return engineerTables.engineers.map((e) => ({
      id: e.id,
      name: e.name,
      phone: e.phone,
      status: e.status,
    }));
  }

  async importElectricalEngineers() {
    return electricalTables.engineers.map((e) => ({
      id: e.id,
      name: e.name,
      phone: e.phone,
      status: e.status,
    }));
  }

  async importContractors() {
    return contractorTables.contractors.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
    }));
  }

  async storedVillaNumbers(): Promise<string[]> {
    return villaTables.villas.map((villa) => villa.villaNumber);
  }

  async storedPlots(areaIds: readonly string[]) {
    return villaTables.villas
      .filter((villa) => areaIds.includes(villa.areaId))
      .map((villa) => ({ areaId: villa.areaId, block: villa.block, plot: villa.plot }));
  }

  async lockRefsShared(refs: ImportRefs): Promise<LockedRefs> {
    const statuses = (ids: readonly string[], rows: { id: string; status: PartyStatusValue }[]) =>
      new Map(rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row.status] as const));
    return {
      areas: new Set(
        areaTables.areas.filter((area) => refs.areaIds.includes(area.id)).map((area) => area.id),
      ),
      civilEngineers: statuses(refs.civilEngineerIds, engineerTables.engineers),
      electricalEngineers: statuses(refs.electricalEngineerIds, electricalTables.engineers),
      contractors: statuses(refs.contractorIds, contractorTables.contractors),
    };
  }

  async createMany(rows: readonly NewVilla[]): Promise<string[]> {
    const ids: string[] = [];
    for (const row of rows) {
      ids.push((await this.create(row)).id);
    }
    return ids;
  }

  async insertProgressRowsForMany(villaIds: readonly string[]): Promise<void> {
    progressTables.insertMissing(
      villaIds.flatMap((villaId) =>
        progressTables.phaseIds().map((elecPhaseId) => ({ villaId, elecPhaseId })),
      ),
    );
  }

  async options() {
    return [...villaTables.villas]
      .sort((a, b) => a.villaNumber.localeCompare(b.villaNumber))
      .slice(0, MAX_OPTIONS)
      .map((p) => ({ id: p.id, villaNumber: p.villaNumber, extra: "must not leak" }));
  }

  async filterOptions() {
    return {
      areas: sortedUnique(villaTables.villas.map((p) => areaNameOf(p.areaId))).slice(0, MAX_FILTER_VALUES),
      blocks: sortedUnique(villaTables.villas.map((p) => p.block)).slice(0, MAX_FILTER_VALUES),
      civilEngineers: engineerTables.engineers
        .filter((e) => villaTables.villas.some((v) => v.civilEngineerId === e.id))
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      electricalEngineers: electricalTables.engineers
        .filter((e) => villaTables.villas.some((v) => v.electricalEngineerId === e.id))
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  }

  async findDetail(id: string): Promise<VillaDetailRow | null> {
    const villa = villaTables.villas.find((p) => p.id === id);
    return villa ? toDetailRow(villa) : null;
  }

  async findListRow(id: string): Promise<VillaListRow | null> {
    const villa = villaTables.villas.find((p) => p.id === id);
    return villa ? toListRow(villa) : null;
  }

  async findSnapshot(id: string): Promise<VillaSnapshotRow | null> {
    const p = villaTables.villas.find((candidate) => candidate.id === id);
    if (!p) return null;
    return {
      villaNumber: p.villaNumber,
      ownerName: p.ownerName,
      villaType: p.villaType,
      areaId: p.areaId,
      block: p.block,
      plot: p.plot,
      civilEngineerId: p.civilEngineerId,
      electricalEngineerId: p.electricalEngineerId,
      contractorId: p.contractorId,
      startDate: p.startDate,
      targetDate: p.targetDate,
      budgetMinor: p.budgetMinor === null ? null : BigInt(p.budgetMinor),
      currency: p.currency,
    };
  }

  async findMark(id: string, mark: VillaMark): Promise<MarkRow | null> {
    const villa = villaTables.villas.find((p) => p.id === id);
    if (!villa) return null;
    switch (mark) {
      case "mewFollowUp":
        return { at: villa.mewFollowUpAt, byId: villa.mewFollowUpById };
      case "mewInspection":
        return { at: villa.mewInspectionAt, byId: villa.mewInspectionById };
      case "mewInspectionPassed":
        return { at: villa.mewInspectionPassedAt, byId: villa.mewInspectionPassedById };
    }
  }

  async setMark(id: string, version: number, mark: VillaMark, value: InspectionMark): Promise<boolean> {
    const villa = villaTables.villas.find((p) => p.id === id);
    if (!villa) throw missingRowError();
    if (villa.version !== version) return false;
    const at = value?.at ?? null;
    const byId = value?.byId ?? null;
    Object.assign(
      villa,
      mark === "mewFollowUp"
        ? { mewFollowUpAt: at, mewFollowUpById: byId }
        : mark === "mewInspection"
          ? { mewInspectionAt: at, mewInspectionById: byId }
          : { mewInspectionPassedAt: at, mewInspectionPassedById: byId },
      { updatedAt: new Date(), version: villa.version + 1 },
    );
    return true;
  }

  async findMewStates(id: string): Promise<MewStatesRow | null> {
    const villa = villaTables.villas.find((p) => p.id === id);
    return villa
      ? {
          mewAcState: villa.mewAcState,
          mewElecState: villa.mewElecState,
          mewInspectionDate: villa.mewInspectionDate,
        }
      : null;
  }

  async setMewStates(id: string, version: number, states: MewStatesPatch): Promise<boolean> {
    const villa = villaTables.villas.find((p) => p.id === id);
    if (!villa) throw missingRowError();
    if (villa.version !== version) return false;
    if (states.mewAcState !== undefined) villa.mewAcState = states.mewAcState;
    if (states.mewElecState !== undefined) villa.mewElecState = states.mewElecState;
    if (states.mewInspectionDate !== undefined) villa.mewInspectionDate = states.mewInspectionDate;
    Object.assign(villa, { updatedAt: new Date(), version: villa.version + 1 });
    return true;
  }

  async areaExists(id: string): Promise<boolean> {
    return areaTables.areas.some((a) => a.id === id);
  }

  async civilEngineerStatus(id: string): Promise<PartyStatusValue | null> {
    return engineerTables.engineers.find((e) => e.id === id)?.status ?? null;
  }

  async electricalEngineerStatus(id: string): Promise<PartyStatusValue | null> {
    return electricalTables.engineers.find((e) => e.id === id)?.status ?? null;
  }

  async contractorStatus(id: string): Promise<PartyStatusValue | null> {
    return contractorTables.contractors.find((c) => c.id === id)?.status ?? null;
  }

  async create(data: NewVilla): Promise<VillaListRow> {
    assertUnique(data);
    assertForeignKeys(data);
    assertChecks(data);
    const now = new Date();
    const villa: StoredVilla = {
      id: randomUUID(),
      mewFollowUpAt: null,
      mewFollowUpById: null,
      mewInspectionAt: null,
      mewInspectionById: null,
      mewInspectionPassedAt: null,
      mewInspectionPassedById: null,
      mewAcState: "NOT_SUBMITTED",
      mewElecState: "NOT_SUBMITTED",
      mewInspectionDate: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...data,
    };
    villaTables.villas.push(villa);
    return toListRow(villa);
  }

  async lockVersion(id: string): Promise<number | null> {
    return villaTables.villas.find((p) => p.id === id)?.version ?? null;
  }

  async updateScalars(id: string, version: number, patch: VillaPatch): Promise<boolean> {
    const villa = villaTables.villas.find((p) => p.id === id);
    if (!villa) throw missingRowError();
    if (villa.version !== version) return false;
    assertUnique({ ...villa, ...patch }, id);
    assertForeignKeys(patch);
    assertChecks({ ...villa, ...patch });
    Object.assign(villa, patch, { updatedAt: new Date(), version: villa.version + 1 });
    return true;
  }

  async delete(id: string, version: number): Promise<boolean> {
    const existing = villaTables.villas.find((p) => p.id === id);
    if (!existing) throw missingRowError();
    if (existing.version !== version) return false;
    villaTables.villas = villaTables.villas.filter((p) => p.id !== id);
    // onDelete: Cascade
    villaTables.documents = villaTables.documents.filter((d) => d.villaId !== id);
    progressTables.rows = progressTables.rows.filter((r) => r.villaId !== id);
    workItemTables.items = workItemTables.items.filter((item) => item.villaId !== id);
    return true;
  }
}
