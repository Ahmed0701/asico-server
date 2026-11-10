import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the daily labour, as a function of a transaction. It imports nothing from this module's
// other files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many daily labour rows a villa has. Such a villa is not deleted: its history is not thrown away with it.
export function countLabourOfVilla(villaId: string, db: Db): Promise<number> {
  return db.dailyLabour.count({ where: { villaId } });
}
