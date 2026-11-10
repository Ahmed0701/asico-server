import type { Prisma } from "../../../generated/prisma/client.js";

// What the villas and the elec phases need from the work items, as functions of a transaction. They import nothing from
// this module's other files, so the other modules can use them without a circular import.

type Db = Prisma.TransactionClient;

// How many open works were typed in for a villa. Such a villa is not deleted: the people who wrote them decide first.
// The automatic ones are not counted: they are made by the progress and go with the villa.
export function countManualItemsOfVilla(villaId: string, db: Db): Promise<number> {
  return db.workItem.count({ where: { villaId, source: "MANUAL" } });
}

// How many open works point at an elec phase, of either source and at any progress: what makes the phase "in use".
export function countItemsOfPhase(phaseId: string, db: Db): Promise<number> {
  return db.workItem.count({ where: { elecPhaseId: phaseId } });
}
