import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the variation orders, as a function of a transaction. It imports nothing from the other
// files of this module, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many variation orders a villa has. Such a villa is not deleted: its variation orders are kept with it.
export function countVariationOrdersOfVilla(villaId: string, db: Db): Promise<number> {
  return db.variationOrder.count({ where: { villaId } });
}

// How many variation orders of a villa are not paid yet. Such a villa is not added for MEW inspection.
export function countPendingVariationOrdersOfVilla(villaId: string, db: Db): Promise<number> {
  return db.variationOrder.count({ where: { villaId, status: "PENDING" } });
}
