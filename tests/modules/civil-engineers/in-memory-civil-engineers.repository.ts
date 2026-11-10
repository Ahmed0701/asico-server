import { randomUUID } from "node:crypto";
import type { PartyStatusValue } from "../../../src/shared/constants/enums.js";
import {
  MAX_OPTIONS,
  type CivilEngineerSort,
} from "../../../src/modules/civil-engineers/dto/civil-engineers.dto.js";
import type {
  CivilEngineerRow,
  CivilEngineersRepository,
  Db,
} from "../../../src/modules/civil-engineers/repository/civil-engineers.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
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

// Plain-memory stand-in for the CivilEngineer table, plus the Villa rows that point at it.
export const engineerTables = {
  engineers: [] as StoredEngineer[],
  villaRefs: [] as { engineerId: string }[],
  // Race switches: each simulates something another request does between the service's lookup and its write.
  linkVillaBeforeDelete: false,
  removeBeforeWrite: false,

  reset(): void {
    this.engineers = [];
    this.villaRefs = [];
    this.linkVillaBeforeDelete = false;
    this.removeBeforeWrite = false;
  },
};

export function addEngineer(overrides: Partial<StoredEngineer> & { name: string }): StoredEngineer {
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
  engineerTables.engineers.push(engineer);
  return engineer;
}

export function addVillaFor(engineerId: string, times = 1): void {
  for (let i = 0; i < times; i++) {
    engineerTables.villaRefs.push({ engineerId });
  }
}

const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

function toRow(engineer: StoredEngineer): CivilEngineerRow {
  return {
    id: engineer.id,
    name: engineer.name,
    phone: engineer.phone,
    email: engineer.email,
    status: engineer.status,
    version: engineer.version,
    createdAt: engineer.createdAt,
    updatedAt: engineer.updatedAt,
    _count: { villas: engineerTables.villaRefs.filter((ref) => ref.engineerId === engineer.id).length },
  };
}

function compare(a: StoredEngineer, b: StoredEngineer, { field, direction }: CivilEngineerSort): number {
  const left = field === "name" ? a.name : a.createdAt.getTime();
  const right = field === "name" ? b.name : b.createdAt.getTime();
  const order = left < right ? -1 : left > right ? 1 : 0;
  return (direction === "asc" ? order : -order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class InMemoryCivilEngineersRepository implements CivilEngineersRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const before = structuredClone({
      engineers: engineerTables.engineers,
      villaRefs: engineerTables.villaRefs,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      engineerTables.engineers = before.engineers;
      engineerTables.villaRefs = before.villaRefs;
      throw err;
    }
  }

  async list(params: {
    search?: string | undefined;
    status?: PartyStatusValue | undefined;
    sort: CivilEngineerSort;
    skip: number;
    take: number;
  }) {
    const needle = params.search?.toLowerCase();
    const matching = engineerTables.engineers
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
    return engineerTables.engineers
      .filter((e) => e.status === "ACTIVE")
      .sort((a, b) => compare(a, b, { field: "name", direction: "asc" }))
      .slice(0, MAX_OPTIONS)
      .map((e) => ({ id: e.id, name: e.name, extra: "must not leak" }));
  }

  async findById(id: string): Promise<CivilEngineerRow | null> {
    const engineer = engineerTables.engineers.find((candidate) => candidate.id === id);
    return engineer ? toRow(engineer) : null;
  }

  async create(data: {
    name: string;
    phone: string;
    email: string | null;
    status: PartyStatusValue;
  }): Promise<CivilEngineerRow> {
    const now = new Date();
    return toRow(addEngineer({ ...data, createdAt: now, updatedAt: now }));
  }

  async lockVersion(id: string): Promise<number | null> {
    return engineerTables.engineers.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async update(
    id: string,
    version: number,
    data: { name?: string; phone?: string; email?: string | null; status?: PartyStatusValue },
  ): Promise<CivilEngineerRow | null> {
    this.applyRaceOfRemoval(id);
    const engineer = engineerTables.engineers.find((candidate) => candidate.id === id);
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
    const engineer = engineerTables.engineers.find((candidate) => candidate.id === id);
    if (!engineer) {
      throw prismaError("P2025");
    }
    if (engineer.version !== version) {
      return false;
    }
    if (engineerTables.linkVillaBeforeDelete) {
      addVillaFor(id);
    }
    // The foreign key from Villa is onDelete: Restrict.
    if (engineerTables.villaRefs.some((ref) => ref.engineerId === id)) {
      throw prismaError("P2003");
    }
    engineerTables.engineers = engineerTables.engineers.filter((candidate) => candidate.id !== id);
    return true;
  }

  private applyRaceOfRemoval(id: string): void {
    if (engineerTables.removeBeforeWrite) {
      engineerTables.engineers = engineerTables.engineers.filter((candidate) => candidate.id !== id);
    }
  }
}
