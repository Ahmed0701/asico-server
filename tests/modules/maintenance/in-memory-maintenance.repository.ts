import { randomUUID } from "node:crypto";
import type { MaintenanceSort } from "../../../src/modules/maintenance/dto/maintenance.dto.js";
import type {
  Db,
  MaintenanceFields,
  MaintenanceRepository,
  MaintenanceRow,
} from "../../../src/modules/maintenance/repository/maintenance.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { maintenanceTables } from "./maintenance-tables.js";

// The maintenance repository over an array: the same filtering, sorting and compare-and-set as the SQL.

const copy = (row: MaintenanceRow): MaintenanceRow => ({ ...row });

function compare(a: MaintenanceRow, b: MaintenanceRow, { field, direction }: MaintenanceSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const value = (row: MaintenanceRow): number | string | null => {
    switch (field) {
      case "villaNumber":
        return row.villaNumber;
      case "createdAt":
        return row.createdAt.getTime();
      case "solvedAt":
        return row.solvedAt?.getTime() ?? null;
      default:
        return row.handoverDate.getTime();
    }
  };
  const x = value(a);
  const y = value(b);
  if (x !== y) {
    // Rows without a value go last, whichever the direction.
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryMaintenanceRepository implements MaintenanceRepository {
  // Like the database: what the work changed is undone when it throws.
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(async () => {
      const before = structuredClone(maintenanceTables.rows);
      try {
        return await inMemoryTransaction(work);
      } catch (err) {
        maintenanceTables.rows = before;
        throw err;
      }
    });
  }

  async list({
    search,
    solved,
    sort,
    skip,
    take,
  }: {
    search?: string | undefined;
    solved?: boolean | undefined;
    sort: MaintenanceSort;
    skip: number;
    take: number;
  }): Promise<{ rows: MaintenanceRow[]; total: number }> {
    const term = search?.toLowerCase();
    const matching = maintenanceTables.rows
      .filter((row) => solved === undefined || (row.solvedAt !== null) === solved)
      .filter(
        (row) =>
          !term ||
          [row.villaNumber, row.location, row.issue].some((text) => text.toLowerCase().includes(term)),
      )
      .sort((a, b) => compare(a, b, sort));
    return { rows: matching.slice(skip, skip + take).map(copy), total: matching.length };
  }

  async findById(id: string): Promise<MaintenanceRow | null> {
    const row = maintenanceTables.rows.find((r) => r.id === id);
    return row ? copy(row) : null;
  }

  async create(data: {
    villaNumber: string;
    location: string;
    handoverDate: Date;
    issue: string;
  }): Promise<MaintenanceRow> {
    const now = new Date();
    const row: MaintenanceRow = {
      id: randomUUID(),
      ...data,
      solvedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    maintenanceTables.rows.push(row);
    return copy(row);
  }

  async lockVersion(id: string): Promise<number | null> {
    return maintenanceTables.rows.find((r) => r.id === id)?.version ?? null;
  }

  async update(id: string, version: number, data: MaintenanceFields): Promise<MaintenanceRow | null> {
    const row = maintenanceTables.rows.find((r) => r.id === id);
    if (!row || row.version !== version) return null;
    Object.assign(row, data, { version: row.version + 1, updatedAt: new Date() });
    return copy(row);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = maintenanceTables.rows.findIndex((r) => r.id === id && r.version === version);
    if (at < 0) return false;
    maintenanceTables.rows.splice(at, 1);
    return true;
  }
}
