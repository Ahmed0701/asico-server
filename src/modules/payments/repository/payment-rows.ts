import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the payments, as a function of a transaction. It imports nothing from this module's other
// files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many payments are for a villa. Such a villa is not deleted: its payments are kept with it.
export function countPaymentsOfVilla(villaId: string, db: Db): Promise<number> {
  return db.contractorPayment.count({ where: { villaId } });
}
