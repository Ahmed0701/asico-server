import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

const select = {
  villaId: true,
  key: true,
  name: true,
  size: true,
  uploadedAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.MewInspectionReportSelect;

export type MewReportRow = Prisma.MewInspectionReportGetPayload<{ select: typeof select }>;
export type NewMewReport = { key: string; name: string; size: number; uploadedAt: Date };

export class MewInspectionReportsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // The reports of these villas (a villa has at most one).
  ofVillas(villaIds: readonly string[], db: Db = prisma): Promise<MewReportRow[]> {
    return db.mewInspectionReport.findMany({ where: { villaId: { in: [...villaIds] } }, select });
  }

  find(villaId: string, db: Db = prisma): Promise<MewReportRow | null> {
    return db.mewInspectionReport.findUnique({ where: { villaId }, select });
  }

  // The villa's number, null when there is no such villa.
  async villaNumber(villaId: string, db: Db = prisma): Promise<string | null> {
    return (
      (await db.villa.findUnique({ where: { id: villaId }, select: { villaNumber: true } }))?.villaNumber ??
      null
    );
  }

  // Locks the villa for the rest of the transaction, so two uploads of its report take turns. False: no such villa.
  async lockVilla(villaId: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId} FOR UPDATE`,
    );
    return rows.length > 0;
  }

  // Puts the report in place (replacing the one there was) and answers it.
  save(villaId: string, uploadedById: string, report: NewMewReport, db: Db): Promise<MewReportRow> {
    return db.mewInspectionReport.upsert({
      where: { villaId },
      create: { villaId, uploadedById, ...report },
      update: { uploadedById, ...report },
      select,
    });
  }

  async delete(villaId: string, db: Db): Promise<boolean> {
    const { count } = await db.mewInspectionReport.deleteMany({ where: { villaId } });
    return count === 1;
  }
}
