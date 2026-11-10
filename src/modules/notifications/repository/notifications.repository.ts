import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

const select = {
  readAt: true,
  createdAt: true,
  notification: {
    select: {
      id: true,
      kind: true,
      data: true,
      smallWork: { select: { id: true, villaId: true } },
      workItem: { select: { id: true, villaId: true } },
    },
  },
} satisfies Prisma.NotificationRecipientSelect;

export type RecipientRow = Prisma.NotificationRecipientGetPayload<{ select: typeof select }>;

// A user's own notifications: every query is scoped by the user, so nobody reads or marks another user's.
export class NotificationsRepository {
  async list(
    userId: string,
    { unread, skip, take }: { unread: boolean; skip: number; take: number },
    db: Db = prisma,
  ): Promise<{ rows: RecipientRow[]; total: number; unreadCount: number }> {
    const where: Prisma.NotificationRecipientWhereInput = { userId, ...(unread ? { readAt: null } : {}) };
    const [rows, total, unreadCount] = await Promise.all([
      db.notificationRecipient.findMany({
        where,
        select,
        // The copies of one run share a moment, so the id breaks the tie and pages never repeat or skip.
        orderBy: [{ createdAt: "desc" }, { notificationId: "asc" }],
        skip,
        take,
      }),
      db.notificationRecipient.count({ where }),
      db.notificationRecipient.count({ where: { userId, readAt: null } }),
    ]);
    return { rows, total, unreadCount };
  }

  // Marks the user's copy read (once: a second call keeps the first time) and returns it. Null: the user has no such
  // notification.
  async markRead(
    userId: string,
    notificationId: string,
    now: Date,
    db: Db = prisma,
  ): Promise<RecipientRow | null> {
    await db.notificationRecipient.updateMany({
      where: { userId, notificationId, readAt: null },
      data: { readAt: now },
    });
    return db.notificationRecipient.findUnique({
      where: { notificationId_userId: { notificationId, userId } },
      select,
    });
  }

  // Marks every unread notification of the user read. Returns how many it changed.
  async markAllRead(userId: string, now: Date, db: Db = prisma): Promise<number> {
    const { count } = await db.notificationRecipient.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now },
    });
    return count;
  }
}
