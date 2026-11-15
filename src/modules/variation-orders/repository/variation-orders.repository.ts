import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { VariationOrderStatusValue } from "../dto/variation-orders.dto.js";

export type Db = Prisma.TransactionClient;

const fileSelect = { id: true, key: true, name: true, mime: true, size: true, uploadedAt: true } as const;

const select = {
  id: true,
  villaId: true,
  voNumber: true,
  amountMinor: true,
  dateAdded: true,
  status: true,
  notes: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  villa: { select: { villaNumber: true } },
  files: { select: fileSelect, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.VariationOrderSelect;

export type VariationOrderRow = Prisma.VariationOrderGetPayload<{ select: typeof select }>;
export type VariationOrderFileRow = VariationOrderRow["files"][number];

export type VariationOrderFields = {
  voNumber?: string;
  amountMinor?: bigint;
  dateAdded?: Date;
  status?: VariationOrderStatusValue;
  notes?: string | null;
};

export type NewVariationOrder = {
  villaId: string;
  voNumber: string;
  amountMinor: bigint;
  dateAdded: Date;
  status: VariationOrderStatusValue;
  notes: string | null;
};

export type NewVariationOrderFile = {
  key: string;
  name: string;
  mime: string;
  size: number;
  uploadedAt: Date;
};

export class VariationOrdersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // The newest date first; `createdAt` and `id` break ties.
  listByVilla(villaId: string, db: Db = prisma): Promise<VariationOrderRow[]> {
    return db.variationOrder.findMany({
      where: { villaId },
      select,
      orderBy: [{ dateAdded: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    });
  }

  findById(id: string, db: Db = prisma): Promise<VariationOrderRow | null> {
    return db.variationOrder.findUnique({ where: { id }, select });
  }

  async villaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // Another variation order of the villa with this number (case-insensitive), other than `exceptId`.
  async numberTaken(villaId: string, voNumber: string, exceptId: string | null, db: Db): Promise<boolean> {
    const row = await db.variationOrder.findFirst({
      where: {
        villaId,
        voNumber: { equals: voNumber, mode: "insensitive" },
        ...(exceptId && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return row !== null;
  }

  create(data: NewVariationOrder, db: Db = prisma): Promise<VariationOrderRow> {
    return db.variationOrder.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "VariationOrder", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: VariationOrderFields,
    db: Db = prisma,
  ): Promise<VariationOrderRow | null> {
    const { count } = await db.variationOrder.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.variationOrder.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more. The rows of its files go with it (ON DELETE CASCADE).
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.variationOrder.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async addFiles(variationOrderId: string, files: readonly NewVariationOrderFile[], db: Db): Promise<void> {
    await db.variationOrderFile.createMany({ data: files.map((file) => ({ ...file, variationOrderId })) });
  }

  countFiles(variationOrderId: string, db: Db): Promise<number> {
    return db.variationOrderFile.count({ where: { variationOrderId } });
  }

  findFile(variationOrderId: string, fileId: string, db: Db = prisma): Promise<VariationOrderFileRow | null> {
    return db.variationOrderFile.findFirst({ where: { id: fileId, variationOrderId }, select: fileSelect });
  }

  async deleteFile(fileId: string, db: Db): Promise<void> {
    await db.variationOrderFile.delete({ where: { id: fileId } });
  }
}
