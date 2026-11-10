import { randomUUID } from "node:crypto";
import { MAX_OPTIONS, type AreaSort } from "../../../src/modules/areas/dto/areas.dto.js";
import type { AreaRow, AreasRepository, Db } from "../../../src/modules/areas/repository/areas.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

export type StoredArea = {
  id: string;
  name: string;
  city: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

// Plain-memory stand-in for the Area table.
export const areaTables = {
  areas: [] as StoredArea[],
  // How many villas are in an area. The villas fake replaces this with a count of its own rows (a villa is a
  // villa for now); until it is loaded, no area has villas.
  villaCountOf: (() => 0) as (areaId: string) => number,
  // Race switches: another request deletes the row, or adds a villa to it, between the service's checks and its write.
  removeBeforeWrite: false,
  villaBeforeWrite: null as (() => void) | null,

  reset(): void {
    this.areas = [];
    this.removeBeforeWrite = false;
    this.villaBeforeWrite = null;
  },
};

export function addArea(overrides: Partial<StoredArea> & { name: string }): StoredArea {
  const now = new Date();
  const area: StoredArea = {
    id: randomUUID(),
    city: "Cairo",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  areaTables.areas.push(area);
  return area;
}

const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function toRow(area: StoredArea): AreaRow {
  return {
    id: area.id,
    name: area.name,
    city: area.city,
    version: area.version,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
    _count: { villas: areaTables.villaCountOf(area.id) },
  };
}

function compare(a: StoredArea, b: StoredArea, { field, direction }: AreaSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const tie = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const order = (left: string | number, right: string | number): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const byName = order(a.name, b.name) || order(a.city, b.city);
  switch (field) {
    case "city":
      return sign * order(a.city, b.city) || order(a.name, b.name) || tie;
    case "villaCount":
      return sign * order(areaTables.villaCountOf(a.id), areaTables.villaCountOf(b.id)) || byName || tie;
    case "createdAt":
      return sign * order(a.createdAt.getTime(), b.createdAt.getTime()) || tie;
    default:
      return sign * order(a.name, b.name) || order(a.city, b.city) || tie;
  }
}

export class InMemoryAreasRepository implements AreasRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const before = structuredClone(areaTables.areas);
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      areaTables.areas = before;
      throw err;
    }
  }

  async list(params: { search?: string | undefined; sort: AreaSort; skip: number; take: number }) {
    const needle = params.search?.toLowerCase();
    const matching = areaTables.areas
      .filter(
        (a) => !needle || a.name.toLowerCase().includes(needle) || a.city.toLowerCase().includes(needle),
      )
      .sort((a, b) => compare(a, b, params.sort));
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async options() {
    return [...areaTables.areas]
      .sort((a, b) => compare(a, b, { field: "name", direction: "asc" }))
      .slice(0, MAX_OPTIONS)
      .map((a) => ({ id: a.id, name: a.name, city: a.city, extra: "must not leak" }));
  }

  async findById(id: string): Promise<AreaRow | null> {
    const area = areaTables.areas.find((candidate) => candidate.id === id);
    return area ? toRow(area) : null;
  }

  async findByNameAndCity(name: string, city: string): Promise<{ id: string } | null> {
    const area = areaTables.areas.find((a) => sameText(a.name, name) && sameText(a.city, city));
    return area ? { id: area.id } : null;
  }

  async create(data: { name: string; city: string }): Promise<AreaRow> {
    // The unique index on (lower("name"), lower("city")): the check the database makes even when the service's missed.
    if (areaTables.areas.some((a) => sameText(a.name, data.name) && sameText(a.city, data.city))) {
      throw prismaError("P2002");
    }
    return toRow(addArea(data));
  }

  async lockVersion(id: string): Promise<number | null> {
    return areaTables.areas.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async update(id: string, version: number, data: { name?: string; city?: string }): Promise<AreaRow | null> {
    this.applyRaces(id);
    const area = areaTables.areas.find((candidate) => candidate.id === id);
    if (!area) {
      throw prismaError("P2025");
    }
    if (area.version !== version) {
      return null;
    }
    const next = { name: data.name ?? area.name, city: data.city ?? area.city };
    if (
      areaTables.areas.some((a) => a.id !== id && sameText(a.name, next.name) && sameText(a.city, next.city))
    ) {
      throw prismaError("P2002");
    }
    Object.assign(area, data, { updatedAt: new Date(), version: area.version + 1 });
    return toRow(area);
  }

  async delete(id: string, version: number): Promise<boolean> {
    this.applyRaces(id);
    const area = areaTables.areas.find((candidate) => candidate.id === id);
    if (!area) {
      throw prismaError("P2025");
    }
    if (area.version !== version) {
      return false;
    }
    // onDelete: Restrict
    if (areaTables.villaCountOf(id) > 0) {
      throw prismaError("P2003");
    }
    areaTables.areas = areaTables.areas.filter((candidate) => candidate.id !== id);
    return true;
  }

  async countVillas(id: string): Promise<number> {
    const count = areaTables.villaCountOf(id);
    // A villa arriving after the count is read: the foreign key has to catch it.
    const hook = areaTables.villaBeforeWrite;
    areaTables.villaBeforeWrite = null;
    hook?.();
    return count;
  }

  private applyRaces(id: string): void {
    if (areaTables.removeBeforeWrite) {
      areaTables.areas = areaTables.areas.filter((candidate) => candidate.id !== id);
    }
  }
}
