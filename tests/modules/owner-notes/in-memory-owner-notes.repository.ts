import { randomUUID } from "node:crypto";
import type { OwnerNoteSort } from "../../../src/modules/owner-notes/dto/owner-notes.dto.js";
import type {
  Db,
  OwnerNoteFields,
  OwnerNoteRow,
  OwnerNotesRepository,
} from "../../../src/modules/owner-notes/repository/owner-notes.repository.js";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { ownerNoteTables, type StoredOwnerNote } from "./owner-notes-tables.js";

// The owner notes repository over an array: the same filtering, sorting and compare-and-set as the SQL. The villa part of a
// row is read from the villa fakes, as the SQL joins it.

function rowOf(stored: StoredOwnerNote): OwnerNoteRow {
  const villa = villaTables.villas.find((v) => v.id === stored.villaId);
  if (!villa) throw new Error(`no villa ${stored.villaId} in the fakes`);
  const area = areaTables.areas.find((a) => a.id === villa.areaId);
  return {
    id: stored.id,
    notes: stored.notes,
    doneAt: stored.doneAt,
    version: stored.version,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    villa: {
      id: villa.id,
      villaNumber: villa.villaNumber,
      ownerName: villa.ownerName,
      block: villa.block,
      plot: villa.plot,
      area: { name: area?.name ?? "" },
    },
  };
}

function compare(a: OwnerNoteRow, b: OwnerNoteRow, { field, direction }: OwnerNoteSort): number {
  const sign = direction === "asc" ? 1 : -1;
  const value = (row: OwnerNoteRow): number | string | null => {
    switch (field) {
      case "villaNumber":
        return row.villa.villaNumber;
      case "doneAt":
        return row.doneAt?.getTime() ?? null;
      default:
        return row.createdAt.getTime();
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

export class InMemoryOwnerNotesRepository implements OwnerNotesRepository {
  // Like the database: what the work changed is undone when it throws.
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(async () => {
      const before = structuredClone(ownerNoteTables.rows);
      try {
        return await inMemoryTransaction(work);
      } catch (err) {
        ownerNoteTables.rows = before;
        throw err;
      }
    });
  }

  async list({
    search,
    done,
    villaId,
    sort,
    skip,
    take,
  }: {
    search?: string | undefined;
    done?: boolean | undefined;
    villaId?: string | undefined;
    sort: OwnerNoteSort;
    skip: number;
    take: number;
  }): Promise<{ rows: OwnerNoteRow[]; total: number }> {
    const term = search?.toLowerCase();
    const matching = ownerNoteTables.rows
      .filter((row) => done === undefined || (row.doneAt !== null) === done)
      .filter((row) => !villaId || row.villaId === villaId)
      .map(rowOf)
      .filter(
        (row) =>
          !term ||
          [row.villa.villaNumber, row.villa.ownerName ?? "", row.notes].some((text) =>
            text.toLowerCase().includes(term),
          ),
      )
      .sort((a, b) => compare(a, b, sort));
    return { rows: matching.slice(skip, skip + take), total: matching.length };
  }

  async findById(id: string): Promise<OwnerNoteRow | null> {
    const stored = ownerNoteTables.rows.find((r) => r.id === id);
    return stored ? rowOf(stored) : null;
  }

  async villaExists(id: string): Promise<boolean> {
    return villaTables.villas.some((v) => v.id === id);
  }

  async create(data: { villaId: string; notes: string }): Promise<OwnerNoteRow> {
    const now = new Date();
    const stored: StoredOwnerNote = {
      id: randomUUID(),
      ...data,
      doneAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    ownerNoteTables.rows.push(stored);
    return rowOf(stored);
  }

  async lockVersion(id: string): Promise<number | null> {
    return ownerNoteTables.rows.find((r) => r.id === id)?.version ?? null;
  }

  async update(id: string, version: number, data: OwnerNoteFields): Promise<OwnerNoteRow | null> {
    const stored = ownerNoteTables.rows.find((r) => r.id === id);
    if (!stored || stored.version !== version) return null;
    Object.assign(stored, data, { version: stored.version + 1, updatedAt: new Date() });
    return rowOf(stored);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = ownerNoteTables.rows.findIndex((r) => r.id === id && r.version === version);
    if (at < 0) return false;
    ownerNoteTables.rows.splice(at, 1);
    return true;
  }
}
