import { randomUUID } from "node:crypto";
import type { ImportBatchRepository } from "../../../src/core/imports/repository.js";

export type StoredBatch = {
  id: string;
  entity: string;
  fileHash: string;
  userId: string;
  rows: number;
  createdAt: Date;
};

// Plain-memory stand-in for the ImportBatch table. The pair (entity, fileHash) is unique, as the index makes it.
export const importBatchTable = {
  rows: [] as StoredBatch[],
  // The entities that took the import lock, in order.
  locks: [] as string[],
  // Makes saving the batch fail, after the records were saved: the case that must roll everything back.
  failCreate: false,

  reset(): void {
    this.rows = [];
    this.locks = [];
    this.failCreate = false;
  },
};

export class InMemoryImportBatchRepository implements Pick<
  ImportBatchRepository,
  "lock" | "isImported" | "create"
> {
  async lock(entity: string): Promise<void> {
    importBatchTable.locks.push(entity);
  }

  async isImported(entity: string, fileHash: string): Promise<boolean> {
    return importBatchTable.rows.some((row) => row.entity === entity && row.fileHash === fileHash);
  }

  async create(data: {
    entity: string;
    fileHash: string;
    userId: string;
    rows: number;
  }): Promise<{ id: string }> {
    if (importBatchTable.failCreate) {
      throw new Error("the database went away");
    }
    if (await this.isImported(data.entity, data.fileHash)) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    const row = { id: randomUUID(), createdAt: new Date(), ...data };
    importBatchTable.rows.push(row);
    return { id: row.id };
  }
}
