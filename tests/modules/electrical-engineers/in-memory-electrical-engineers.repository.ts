import { randomUUID } from "node:crypto";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import {
  MAX_OPTIONS,
  type ElectricalEngineerSort,
} from "../../../src/modules/electrical-engineers/dto/electrical-engineers.dto.js";
import type {
  Db,
  ElectricalEngineerRow,
  ElectricalEngineersRepository,
} from "../../../src/modules/electrical-engineers/repository/electrical-engineers.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

type StoredEngineer = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: PartyStatusValue;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

// Plain-memory stand-in for the ElectricalEngineer table, plus the Villa rows that point at it.
export const electricalTables = {
  engineers: [] as StoredEngineer[],
  villaRefs: [] as { engineerId: string }[],
  // Race switches: each simulates something another request does between the service's lookup and its write.
  linkVillaBeforeDelete: false,
  removeBeforeWrite: false,

  reset(): void {
    this.engineers = [];
    this.villaRefs = [];
    dailyReportTables.reset();
    this.linkVillaBeforeDelete = false;
    this.removeBeforeWrite = false;
  },
};

export function addVillaForElectrical(engineerId: string, times = 1): void {
  for (let i = 0; i < times; i++) {
    electricalTables.villaRefs.push({ engineerId });
  }
}

export function addElectricalEngineer(overrides: Partial<StoredEngineer> & { name: string }): StoredEngineer {
  const now = new Date();
  const engineer: StoredEngineer = {
    id: randomUUID(),
    phone: "0100 123 4567",
    email: null,
    status: "ACTIVE",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  electricalTables.engineers.push(engineer);
  return engineer;
}

const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

function toRow(engineer: StoredEngineer): ElectricalEngineerRow {
  return {
    id: engineer.id,
    name: engineer.name,
    phone: engineer.phone,
    email: engineer.email,
    status: engineer.status,
    version: engineer.version,
    createdAt: engineer.createdAt,
    updatedAt: engineer.updatedAt,
    _count: {
      villas: electricalTables.villaRefs.filter((ref) => ref.engineerId === engineer.id).length,
      dailyReports: dailyReportTables.count({ preparedByEngineerId: engineer.id }),
    },
  };
}

function compare(a: StoredEngineer, b: StoredEngineer, { field, direction }: ElectricalEngineerSort): number {
  const left = field === "name" ? a.name : a.createdAt.getTime();
  const right = field === "name" ? b.name : b.createdAt.getTime();
  const order = left < right ? -1 : left > right ? 1 : 0;
  return (direction === "asc" ? order : -order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class InMemoryElectricalEngineersRepository implements ElectricalEngineersRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const before = structuredClone({
      engineers: electricalTables.engineers,
      villaRefs: electricalTables.villaRefs,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      electricalTables.engineers = before.engineers;
      electricalTables.villaRefs = before.villaRefs;
      throw err;
    }
  }

  async list(params: {
    search?: string | undefined;
    status?: PartyStatusValue | undefined;
    sort: ElectricalEngineerSort;
    skip: number;
    take: number;
  }) {
    const needle = params.search?.toLowerCase();
    const matching = electricalTables.engineers
      .filter((e) => !params.status || e.status === params.status)
      .filter(
        (e) =>
          !needle ||
          e.name.toLowerCase().includes(needle) ||
          e.phone.toLowerCase().includes(needle) ||
          (e.email ?? "").includes(needle),
      )
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async options() {
    return electricalTables.engineers
      .filter((e) => e.status === "ACTIVE")
      .sort((a, b) => compare(a, b, { field: "name", direction: "asc" }))
      .slice(0, MAX_OPTIONS)
      .map((e) => ({ id: e.id, name: e.name, extra: "must not leak" }));
  }

  async findById(id: string): Promise<ElectricalEngineerRow | null> {
    const engineer = electricalTables.engineers.find((candidate) => candidate.id === id);
    return engineer ? toRow(engineer) : null;
  }

  async create(data: {
    name: string;
    phone: string;
    email: string | null;
    status: PartyStatusValue;
  }): Promise<ElectricalEngineerRow> {
    const now = new Date();
    return toRow(addElectricalEngineer({ ...data, createdAt: now, updatedAt: now }));
  }

  async lockVersion(id: string): Promise<number | null> {
    return electricalTables.engineers.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async update(
    id: string,
    version: number,
    data: { name?: string; phone?: string; email?: string | null; status?: PartyStatusValue },
  ): Promise<ElectricalEngineerRow | null> {
    this.applyRaceOfRemoval(id);
    const engineer = electricalTables.engineers.find((candidate) => candidate.id === id);
    if (!engineer) {
      throw prismaError("P2025");
    }
    if (engineer.version !== version) {
      return null;
    }
    Object.assign(engineer, data, { updatedAt: new Date(), version: engineer.version + 1 });
    return toRow(engineer);
  }

  async delete(id: string, version: number): Promise<boolean> {
    this.applyRaceOfRemoval(id);
    const engineer = electricalTables.engineers.find((candidate) => candidate.id === id);
    if (!engineer) {
      throw prismaError("P2025");
    }
    if (engineer.version !== version) {
      return false;
    }
    if (electricalTables.linkVillaBeforeDelete) {
      addVillaForElectrical(id);
    }
    // The foreign keys from Villa and from DailyReport are onDelete: Restrict.
    if (
      electricalTables.villaRefs.some((ref) => ref.engineerId === id) ||
      dailyReportTables.count({ preparedByEngineerId: id }) > 0
    ) {
      throw prismaError("P2003");
    }
    electricalTables.engineers = electricalTables.engineers.filter((candidate) => candidate.id !== id);
    return true;
  }

  private applyRaceOfRemoval(id: string): void {
    if (electricalTables.removeBeforeWrite) {
      electricalTables.engineers = electricalTables.engineers.filter((candidate) => candidate.id !== id);
    }
  }
}
