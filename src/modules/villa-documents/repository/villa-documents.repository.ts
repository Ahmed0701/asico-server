import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

// The fields of a document as the API shows it.
export const villaDocumentSelect = {
  id: true,
  villaId: true,
  originalName: true,
  sizeBytes: true,
  mimeType: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.VillaDocumentSelect;

export type VillaDocumentRow = Prisma.VillaDocumentGetPayload<{ select: typeof villaDocumentSelect }>;

const storedSelect = {
  ...villaDocumentSelect,
  storageKey: true,
} satisfies Prisma.VillaDocumentSelect;
export type StoredFileRow = Prisma.VillaDocumentGetPayload<{ select: typeof storedSelect }>;

// Oldest first; the id settles ties.
const documentOrder = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.VillaDocumentOrderByWithRelationInput[];

export type NewVillaDocument = {
  villaId: string;
  storageKey: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedById: string;
};

export class VillaDocumentsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async villaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // Takes the villa's row lock until the transaction ends. Uploads to one villa queue up behind it, so the
  // document count is always read and written as one consistent step. False: no such villa.
  async lockVilla(villaId: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "Villa" WHERE "id" = ${villaId} FOR UPDATE`;
    return rows.length > 0;
  }

  countDocuments(villaId: string, db: Db = prisma): Promise<number> {
    return db.villaDocument.count({ where: { villaId } });
  }

  createDocument(data: NewVillaDocument, db: Db): Promise<VillaDocumentRow> {
    return db.villaDocument.create({ data, select: villaDocumentSelect });
  }

  listByVilla(villaId: string, db: Db = prisma): Promise<VillaDocumentRow[]> {
    return db.villaDocument.findMany({
      where: { villaId },
      select: villaDocumentSelect,
      orderBy: documentOrder,
    });
  }

  findStored(id: string, db: Db = prisma): Promise<StoredFileRow | null> {
    return db.villaDocument.findUnique({ where: { id }, select: storedSelect });
  }

  async deleteDocument(id: string, db: Db): Promise<void> {
    await db.villaDocument.delete({ where: { id } });
  }
}
