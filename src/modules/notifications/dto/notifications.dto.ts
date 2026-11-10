import type { PageMeta } from "../../../shared/query/pagination.js";

// What a notification is about. One kind per situation of a small work or an open work (see the Notification model).
export const NOTIFICATION_KINDS = ["SMALL_WORK_DUE_SOON", "SMALL_WORK_OVERDUE", "OPEN_WORK_OVERDUE"] as const;
export type NotificationKindValue = (typeof NOTIFICATION_KINDS)[number];

// The text of the alert as it was when it was raised, kept in the row so that history does not change when the work is edited.
export type NotificationData = {
  villaNumber: string;
  // The small work's description, or the open work's electrical phase.
  description: string;
  // "-" for an open work with no contractor.
  contractorName: string;
  // YYYY-MM-DD
  endDate: string;
};

export type LocalizedText = { en: string; ar: string };

export type NotificationDto = {
  id: string;
  kind: NotificationKindValue;
  // Both languages, so a client does not have to ask again when the user switches: the code is `kind`, the texts are labels.
  title: LocalizedText;
  body: LocalizedText;
  // What to open when the notification is clicked.
  entity: { type: "SMALL_WORK" | "OPEN_WORK"; id: string; villaId: string };
  data: NotificationData;
  read: boolean;
  readAt: string | null;
  createdAt: string;
};

// The page, and how many of the user's notifications are unread over the whole list (not only this page or filter).
export type NotificationListMeta = PageMeta & { unreadCount: number };
export type NotificationListResult = { items: NotificationDto[]; meta: NotificationListMeta };
