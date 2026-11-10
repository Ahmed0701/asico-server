import { prisma } from "../database/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

// The record that a file was imported (see the ImportBatch model).
export class ImportBatchRepository {
  // Holds a lock until the end of the transaction, so two imports into the same table run one after the other and
  // the second sees what the first saved. Nothing else is blocked.
  async lock(entity: string, db: Db): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`import:${entity}`}, 0))`;
  }

  async isImported(entity: string, fileHash: string, db: Db = prisma): Promise<boolean> {
    const found = await db.importBatch.findUnique({
      where: { entity_fileHash: { entity, fileHash } },
      select: { id: true },
    });
    return found !== null;
  }

  create(
    data: { entity: string; fileHash: string; userId: string; rows: number },
    db: Db,
  ): Promise<{ id: string }> {
    return db.importBatch.create({ data, select: { id: true } });
  }
}
