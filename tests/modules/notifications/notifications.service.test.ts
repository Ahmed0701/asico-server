import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsService } from "../../../src/modules/notifications/service/notifications.service.js";
import type { NotificationsRepository } from "../../../src/modules/notifications/repository/notifications.repository.js";
import {
  InMemoryNotificationsRepository,
  addNotification,
  notificationTables,
} from "./in-memory-notifications.repository.js";

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: {} }));

const NOW = new Date("2026-11-05T17:00:00.000Z");
const service = () =>
  new NotificationsService(
    new InMemoryNotificationsRepository() as unknown as NotificationsRepository,
    () => NOW,
  );
const actor = { id: "u1", role: "EMPLOYEE" } as const;

beforeEach(() => notificationTables.reset());

describe("NotificationsService", () => {
  it("marks a notification read at the time of the clock", async () => {
    const copy = addNotification({ userId: "u1" });

    const dto = await service().markRead(actor, copy.notificationId, { locale: "en" });

    expect(dto.readAt).toBe(NOW.toISOString());
    expect(copy.readAt).toEqual(NOW);
  });

  it("marks all of a user's notifications read at the time of the clock", async () => {
    const copy = addNotification({ userId: "u1" });

    expect(await service().markAllRead(actor)).toEqual({ updated: 1 });
    expect(copy.readAt).toEqual(NOW);
  });

  it("passes the page to the repository and reports the unread count with it", async () => {
    addNotification({ userId: "u1" });

    const page = await service().list(actor, { page: 1, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.meta).toMatchObject({ page: 1, limit: 20, total: 1, unreadCount: 1 });
  });
});
