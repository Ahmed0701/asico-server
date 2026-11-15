import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas need from the foreman missions, as a function of a transaction. It imports nothing from this module's other
// files, so the villas module can use it without a circular import.

type Db = Prisma.TransactionClient;

// How many foreman missions a villa has. Such a villa is not deleted: its notes are kept with it.
export function countForemanMissionsOfVilla(villaId: string, db: Db): Promise<number> {
  return db.foremanMission.count({ where: { villaId } });
}
