import { randomUUID } from "node:crypto";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { SMALL_WORKS_ALERT_JOB_LOCK } from "../../../shared/constants/locks.js";
import { toDay } from "../../../shared/utils/day.js";
import type { AlertWindow } from "../../../shared/utils/deadline.js";
import type { NotificationData, NotificationKindValue } from "../dto/notifications.dto.js";

export type Db = Prisma.TransactionClient;

// A pending small work that has no notification yet for its situation (its kind and end date).
export type DueSmallWork = {
  id: string;
  kind: NotificationKindValue;
  endDate: Date;
  description: string;
  villaNumber: string;
  contractorName: string;
};

// An open work past its end date and not done, that has no notification yet for that end date.
export type OverdueOpenWork = {
  id: string;
  endDate: Date;
  phaseName: string;
  villaNumber: string;
  contractorName: string | null;
};

export type UnsentNotification = { id: string; kind: NotificationKindValue; data: Prisma.JsonValue };

export type Admin = { id: string; email: string; name: string };

// What the hourly job reads and writes. It never audits: the notifications are a derived feed, not a change a person made.
export class SmallWorksAlertsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number; maxWait: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  // Takes the job's lock until the transaction ends, or says another instance holds it (false) without waiting.
  async tryLock(db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ locked: boolean }[]>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${SMALL_WORKS_ALERT_JOB_LOCK})) AS "locked"`,
    );
    return rows[0]?.locked === true;
  }

  // The pending works whose situation has no notification yet. A work that is past its end date is OVERDUE (even if it was
  // never reported as due soon); one that ends today or in the hours ahead is DUE_SOON; the key of a situation is the work, the
  // kind and the end date, so a work whose end date moved is a new one. A work that is DONE is never listed.
  findDue({ today, horizon }: AlertWindow, db: Db): Promise<DueSmallWork[]> {
    return db.$queryRaw<DueSmallWork[]>(Prisma.sql`
      SELECT due."id", due."kind"::"NotificationKind" AS "kind", due."endDate", due."description", due."villaNumber", due."contractorName"
      FROM (
        SELECT w."id", w."endDate", w."description", v."villaNumber", c."name" AS "contractorName",
          CASE WHEN w."endDate" < ${today}::date THEN 'SMALL_WORK_OVERDUE' ELSE 'SMALL_WORK_DUE_SOON' END AS "kind"
        FROM "DailySmallWork" w
        JOIN "Villa" v ON v."id" = w."villaId"
        JOIN "Contractor" c ON c."id" = w."contractorId"
        WHERE w."status" = 'PENDING' AND w."endDate" < ${horizon}::date
      ) due
      WHERE NOT EXISTS (
        SELECT 1 FROM "Notification" n
        WHERE n."smallWorkId" = due."id" AND n."endDate" = due."endDate" AND n."kind"::text = due."kind"
      )
      ORDER BY due."endDate" ASC, due."id" ASC`);
  }

  // The open works that are overdue on `today` (APP_TIMEZONE, YYYY-MM-DD) and have no OPEN_WORK_OVERDUE notification for their
  // end date yet. A moved end date is a new situation, so the work is reported again once it is late again.
  findOverdueOpenWorks(today: string, db: Db): Promise<OverdueOpenWork[]> {
    return db.$queryRaw<OverdueOpenWork[]>(Prisma.sql`
      SELECT w."id", w."endDate", p."name" AS "phaseName", v."villaNumber", c."name" AS "contractorName"
      FROM "WorkItem" w
      JOIN "Villa" v ON v."id" = w."villaId"
      JOIN "ElecPhase" p ON p."id" = w."elecPhaseId"
      LEFT JOIN "Contractor" c ON c."id" = w."contractorId"
      WHERE w."endDate" < ${today}::date AND w."status" <> 'DONE'
        AND NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE n."workItemId" = w."id" AND n."endDate" = w."endDate" AND n."kind" = 'OPEN_WORK_OVERDUE'
        )
      ORDER BY w."endDate" ASC, w."id" ASC`);
  }

  // Saves one OPEN_WORK_OVERDUE notification per work and a copy for every recipient. The unique key (work, kind, end date) has
  // the last word, as for the small works. Returns how many this call really made.
  async createOpenWorkNotifications(
    works: readonly OverdueOpenWork[],
    recipientIds: readonly string[],
    db: Db,
  ): Promise<number> {
    if (works.length === 0) {
      return 0;
    }
    const planned = works.map((work) => ({ id: randomUUID(), work }));
    await db.notification.createMany({
      data: planned.map(({ id, work }) => ({
        id,
        kind: "OPEN_WORK_OVERDUE" as const,
        workItemId: work.id,
        endDate: work.endDate,
        data: {
          villaNumber: work.villaNumber,
          description: work.phaseName,
          contractorName: work.contractorName ?? "-",
          endDate: toDay(work.endDate),
        } satisfies NotificationData,
      })),
      skipDuplicates: true,
    });
    const made = await db.notification.findMany({
      where: { id: { in: planned.map(({ id }) => id) } },
      select: { id: true },
    });
    if (made.length > 0 && recipientIds.length > 0) {
      await db.notificationRecipient.createMany({
        data: made.flatMap(({ id }) => recipientIds.map((userId) => ({ notificationId: id, userId }))),
        skipDuplicates: true,
      });
    }
    return made.length;
  }

  // Who sees a notification: the active ADMIN users, and the active users who hold the permission to read what it is about
  // (small-works:read by default, open-works:read for the open works).
  async recipientIds(db: Db, permission: string = PERMISSIONS.SMALL_WORKS_READ): Promise<string[]> {
    const users = await db.user.findMany({
      where: {
        isActive: true,
        OR: [{ role: "ADMIN" }, { permissions: { some: { permission: { code: permission } } } }],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return users.map((user) => user.id);
  }

  // The active ADMIN users, who also get the digest email.
  admins(db: Db): Promise<Admin[]> {
    return db.user.findMany({
      where: { isActive: true, role: "ADMIN" },
      select: { id: true, email: true, name: true },
      orderBy: { id: "asc" },
    });
  }

  // Saves the notifications and one copy of each for every recipient. The unique key (work, kind, end date) has the last word:
  // a situation that already has a notification is skipped, so the ids returned are those this call really made.
  async createNotifications(
    works: readonly DueSmallWork[],
    recipientIds: readonly string[],
    db: Db,
  ): Promise<{ id: string; kind: NotificationKindValue }[]> {
    if (works.length === 0) {
      return [];
    }
    const planned = works.map((work) => ({ id: randomUUID(), work }));
    await db.notification.createMany({
      data: planned.map(({ id, work }) => ({
        id,
        kind: work.kind,
        smallWorkId: work.id,
        endDate: work.endDate,
        data: {
          villaNumber: work.villaNumber,
          description: work.description,
          contractorName: work.contractorName,
          endDate: toDay(work.endDate),
        } satisfies NotificationData,
      })),
      skipDuplicates: true,
    });
    const made = await db.notification.findMany({
      where: { id: { in: planned.map(({ id }) => id) } },
      select: { id: true, kind: true },
    });
    if (made.length > 0 && recipientIds.length > 0) {
      await db.notificationRecipient.createMany({
        data: made.flatMap(({ id }) => recipientIds.map((userId) => ({ notificationId: id, userId }))),
        skipDuplicates: true,
      });
    }
    return made;
  }

  // The small works' notifications whose digest has not been sent, and whose work is still pending, oldest first. The open works'
  // notifications are in-app only: they are never emailed.
  unsent(db: Db): Promise<UnsentNotification[]> {
    return db.notification.findMany({
      where: { emailedAt: null, smallWorkId: { not: null }, smallWork: { is: { status: "PENDING" } } },
      select: { id: true, kind: true, data: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async markEmailed(ids: readonly string[], now: Date, db: Db): Promise<void> {
    await db.notification.updateMany({
      where: { id: { in: [...ids] }, emailedAt: null },
      data: { emailedAt: now },
    });
  }
}
