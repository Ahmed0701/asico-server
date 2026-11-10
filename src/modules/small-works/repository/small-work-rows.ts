import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the daily small works, as a function of a transaction. It imports nothing from this module's
// other files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many daily small works a villa has. Such a villa is not deleted: its history is not thrown away with it.
export function countSmallWorksOfVilla(villaId: string, db: Db): Promise<number> {
  return db.dailySmallWork.count({ where: { villaId } });
}
