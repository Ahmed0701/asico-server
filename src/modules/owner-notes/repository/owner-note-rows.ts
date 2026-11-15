import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the owner notes, as a function of a transaction. It imports nothing from this module's other
// files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many owner notes a villa has. Such a villa is not deleted: its notes are kept with it.
export function countOwnerNotesOfVilla(villaId: string, db: Db): Promise<number> {
  return db.ownerNote.count({ where: { villaId } });
}
