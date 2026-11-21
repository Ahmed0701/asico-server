import { prisma } from "../../../core/database/prisma.js";
import { andVillaScope } from "../../../core/scope/villa-scope.js";
import { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  villaId: true,
  key: true,
  name: true,
  mime: true,
  size: true,
  uploadedAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.VillaImageSelect;

export type VillaImageRow = Prisma.VillaImageGetPayload<{ select: typeof select }>;
export type NewVillaImage = { key: string; name: string; mime: string; size: number; uploadedAt: Date };

export class VillaImagesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // The newest first.
  listByVilla(villaId: string, db: Db = prisma): Promise<VillaImageRow[]> {
    return db.villaImage.findMany({
      where: { villaId },
      select,
      orderBy: [{ uploadedAt: "desc" }, { id: "asc" }],
    });
  }

  findById(id: string, db: Db = prisma): Promise<VillaImageRow | null> {
    return db.villaImage.findUnique({ where: { id }, select });
  }

  // The villa's number, null when there is no such villa.
  async villaNumber(villaId: string, db: Db = prisma): Promise<string | null> {
    return (
      (await db.villa.findUnique({ where: { id: villaId }, select: { villaNumber: true } }))?.villaNumber ??
      null
    );
  }

  // Locks the villa for the rest of the transaction, so two uploads take turns on its limit. False: no such villa.
  async lockVilla(villaId: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId}${andVillaScope("Villa")} FOR UPDATE`,
    );
    return rows.length > 0;
  }

  count(villaId: string, db: Db): Promise<number> {
    return db.villaImage.count({ where: { villaId } });
  }

  async addMany(
    villaId: string,
    uploadedById: string,
    images: readonly NewVillaImage[],
    db: Db,
  ): Promise<void> {
    await db.villaImage.createMany({ data: images.map((image) => ({ ...image, villaId, uploadedById })) });
  }

  async delete(id: string, db: Db): Promise<boolean> {
    const { count } = await db.villaImage.deleteMany({ where: { id } });
    return count === 1;
  }
}
