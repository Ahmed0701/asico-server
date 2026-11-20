import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  villaNumber: true,
  block: true,
  plot: true,
  version: true,
  vendorsListedAt: true,
  area: { select: { name: true } },
  switchgearFactory: { select: { id: true, name: true } },
  cableFactory: { select: { id: true, name: true } },
} satisfies Prisma.VillaSelect;

export type VendorVillaRow = Prisma.VillaGetPayload<{ select: typeof select }>;

export type VendorFields = {
  switchgearFactoryId?: string | null;
  cableFactoryId?: string | null;
  vendorsListedAt?: Date | null;
};

export class MaterialVendorsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // The villas on the Vendors list with their assigned factories: a few thousand rows at most, worked on in memory.
  listed(db: Db = prisma): Promise<VendorVillaRow[]> {
    return db.villa.findMany({ where: { vendorsListedAt: { not: null } }, select });
  }

  // The villas not on the list yet (the ones that can be added), by number.
  available(db: Db = prisma): Promise<{ id: string; villaNumber: string }[]> {
    return db.villa.findMany({
      where: { vendorsListedAt: null },
      select: { id: true, villaNumber: true },
    });
  }

  // Every villa with no factory assigned at all, on the Vendors list or not.
  countUnassigned(db: Db = prisma): Promise<number> {
    return db.villa.count({ where: { switchgearFactoryId: null, cableFactoryId: null } });
  }

  findVilla(id: string, db: Db = prisma): Promise<VendorVillaRow | null> {
    return db.villa.findUnique({ where: { id }, select });
  }

  lockVilla(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "Villa", id);
  }

  // Locks the factory (its type cannot change meanwhile) and gives its type; null when there is no such factory.
  async lockFactory(id: string, db: Db): Promise<FactoryTypeValue | null> {
    if ((await lockVersion(db, "Factory", id)) === null) return null;
    return (await db.factory.findUnique({ where: { id }, select: { type: true } }))?.type ?? null;
  }

  // Compare-and-set on the villa's version, which moves on (a villa form open elsewhere learns the villa changed).
  async assign(id: string, version: number, data: VendorFields, db: Db): Promise<VendorVillaRow | null> {
    const { count } = await db.villa.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? this.findVilla(id, db) : null;
  }
}

// How many villas a factory is assigned to (either type): such a factory is not deleted, nor moved to the other type.
export async function countVillasOfFactory(factoryId: string, db: Db): Promise<number> {
  return db.villa.count({
    where: { OR: [{ switchgearFactoryId: factoryId }, { cableFactoryId: factoryId }] },
  });
}
