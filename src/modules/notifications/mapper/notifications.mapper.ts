import { fill } from "../../../core/i18n/fill.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";
import type { NotificationData, NotificationDto, NotificationKindValue } from "../dto/notifications.dto.js";
import type { RecipientRow } from "../repository/notifications.repository.js";

const TEXT_KEYS: Record<NotificationKindValue, { title: MessageKey; body: MessageKey }> = {
  SMALL_WORK_DUE_SOON: {
    title: "notifications.smallWorkDueSoon.title",
    body: "notifications.smallWorkDueSoon.body",
  },
  SMALL_WORK_OVERDUE: {
    title: "notifications.smallWorkOverdue.title",
    body: "notifications.smallWorkOverdue.body",
  },
  OPEN_WORK_OVERDUE: {
    title: "notifications.openWorkOverdue.title",
    body: "notifications.openWorkOverdue.body",
  },
};

// The thing the notification is about: the database keeps exactly one of the two set.
function entityOf(notification: RecipientRow["notification"]): NotificationDto["entity"] {
  if (notification.workItem) {
    return { type: "OPEN_WORK", id: notification.workItem.id, villaId: notification.workItem.villaId };
  }
  return {
    type: "SMALL_WORK",
    id: notification.smallWork?.id ?? "",
    villaId: notification.smallWork?.villaId ?? "",
  };
}

// The data column is written by the job only; anything that is not text reads as empty instead of failing the whole list.
export function dataOf(value: unknown): NotificationData {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (key: string): string => {
    const found = record[key];
    return typeof found === "string" ? found : "";
  };
  return {
    villaNumber: text("villaNumber"),
    description: text("description"),
    contractorName: text("contractorName"),
    endDate: text("endDate"),
  };
}

// The title and body in both languages, made from the kind and the data.
export function textsOf(
  kind: NotificationKindValue,
  data: NotificationData,
): Pick<NotificationDto, "title" | "body"> {
  const values = {
    villa: data.villaNumber,
    description: data.description,
    contractor: data.contractorName,
    endDate: data.endDate,
  };
  const make = (key: MessageKey): Record<LocaleCode, string> => ({
    en: fill(t("en", key), values),
    ar: fill(t("ar", key), values),
  });
  return { title: make(TEXT_KEYS[kind].title), body: make(TEXT_KEYS[kind].body) };
}

export function toNotificationDto(row: RecipientRow): NotificationDto {
  const { notification } = row;
  const data = dataOf(notification.data);
  return {
    id: notification.id,
    kind: notification.kind,
    ...textsOf(notification.kind, data),
    entity: entityOf(notification),
    data,
    read: row.readAt !== null,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
