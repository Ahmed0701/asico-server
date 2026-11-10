import { randomUUID } from "node:crypto";
import type { RecipientRow } from "../../../src/modules/notifications/repository/notifications.repository.js";

// An in-memory stand-in for NotificationsRepository: the same scoping by user and the same answers, over a plain table.
type StoredCopy = {
  userId: string;
  notificationId: string;
  kind: RecipientRow["notification"]["kind"];
  data: unknown;
  smallWorkId: string;
  villaId: string;
  readAt: Date | null;
  createdAt: Date;
};

class Table {
  rows: StoredCopy[] = [];
  reset(): void {
    this.rows = [];
  }
}

export const notificationTables = new Table();

// One notification for one user. A test that wants the same notification for two users adds two copies with the same id.
export function addNotification(
  extra: Partial<StoredCopy> & { userId: string },
): StoredCopy & { notificationId: string } {
  const copy: StoredCopy = {
    notificationId: randomUUID(),
    kind: "SMALL_WORK_DUE_SOON",
    data: {
      villaNumber: "P-001",
      description: "Fix the wall",
      contractorName: "Nile Builders",
      endDate: "2026-11-05",
    },
    smallWorkId: randomUUID(),
    villaId: randomUUID(),
    readAt: null,
    createdAt: new Date("2026-11-05T13:00:00.000Z"),
    ...extra,
  };
  notificationTables.rows.push(copy);
  return copy;
}

const toRow = (copy: StoredCopy): RecipientRow =>
  ({
    readAt: copy.readAt,
    createdAt: copy.createdAt,
    notification: {
      id: copy.notificationId,
      kind: copy.kind,
      data: copy.data,
      smallWork: { id: copy.smallWorkId, villaId: copy.villaId },
    },
  }) as RecipientRow;

export class InMemoryNotificationsRepository {
  async list(
    userId: string,
    { unread, skip, take }: { unread: boolean; skip: number; take: number },
  ): Promise<{ rows: RecipientRow[]; total: number; unreadCount: number }> {
    const own = notificationTables.rows.filter((copy) => copy.userId === userId);
    const matching = own
      .filter((copy) => !unread || copy.readAt === null)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || a.notificationId.localeCompare(b.notificationId),
      );
    return {
      rows: matching.slice(skip, skip + take).map(toRow),
      total: matching.length,
      unreadCount: own.filter((copy) => copy.readAt === null).length,
    };
  }

  async markRead(userId: string, notificationId: string, now: Date): Promise<RecipientRow | null> {
    const copy = notificationTables.rows.find(
      (row) => row.userId === userId && row.notificationId === notificationId,
    );
    if (!copy) {
      return null;
    }
    copy.readAt ??= now;
    return toRow(copy);
  }

  async markAllRead(userId: string, now: Date): Promise<number> {
    const unread = notificationTables.rows.filter((row) => row.userId === userId && row.readAt === null);
    for (const copy of unread) {
      copy.readAt = now;
    }
    return unread.length;
  }
}
