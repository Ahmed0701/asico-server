import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the material deliveries, as a function of a transaction. It imports nothing from this
// module's other files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many deliveries a villa has. Such a villa is not deleted: its delivery notes are kept with it.
export function countDeliveriesOfVilla(villaId: string, db: Db): Promise<number> {
  return db.materialDelivery.count({ where: { villaId } });
}
