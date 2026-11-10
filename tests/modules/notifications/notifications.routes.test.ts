import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addNotification, notificationTables } from "./in-memory-notifications.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/notifications/repository/notifications.repository.js", async () => ({
  NotificationsRepository: (await import("./in-memory-notifications.repository.js"))
    .InMemoryNotificationsRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();

let admin: User;
let employee: User;

beforeEach(() => {
  store.reset();
  notificationTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  // No permission at all: reading one's own notifications needs only a signed-in user.
  employee = store.addUser({ name: "Some Employee", email: "e@example.test", passwordHash: "x" });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
const get = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language);
const post = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .post(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language);

describe("access", () => {
  it.each([
    ["get", "/notifications"],
    ["post", "/notifications/read-all"],
    ["post", `/notifications/${randomUUID()}/read`],
  ] as const)("%s %s requires authentication", async (verb, path) => {
    const res = await request(app)[verb](`/api/v1${path}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("answers a user with no permission at all, with an empty list", async () => {
    const res = await get("/notifications", employee);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], meta: { total: 0, unreadCount: 0 } });
  });
});

describe("GET /notifications", () => {
  it("answers the caller's notifications with both languages, the entity and the read state", async () => {
    const copy = addNotification({ userId: admin.id, kind: "SMALL_WORK_OVERDUE" });

    const res = await get("/notifications");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: copy.notificationId,
        kind: "SMALL_WORK_OVERDUE",
        title: { en: "Small work overdue", ar: expect.stringContaining("") },
        body: {
          en: 'Villa P-001: "Fix the wall" (Nile Builders) was due on 2026-11-05 and is not done.',
          ar: expect.stringContaining("P-001"),
        },
        entity: { type: "SMALL_WORK", id: copy.smallWorkId, villaId: copy.villaId },
        data: {
          villaNumber: "P-001",
          description: "Fix the wall",
          contractorName: "Nile Builders",
          endDate: "2026-11-05",
        },
        read: false,
        readAt: null,
        createdAt: "2026-11-05T13:00:00.000Z",
      },
    ]);
    expect(res.body.data[0].title.ar).not.toBe(res.body.data[0].title.en);
    expect(res.body.data[0].body.ar).toContain("Fix the wall");
  });

  it("is the same in both languages whatever the request asks for", async () => {
    addNotification({ userId: admin.id });

    const english = await get("/notifications", admin, "en");
    const arabic = await get("/notifications", admin, "ar");

    expect(arabic.body.data).toEqual(english.body.data);
  });

  it("never shows another user's notifications", async () => {
    addNotification({ userId: employee.id });
    const mine = addNotification({ userId: admin.id });

    const res = await get("/notifications");

    expect(res.body.data.map((one: { id: string }) => one.id)).toEqual([mine.notificationId]);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.meta.unreadCount).toBe(1);
  });

  it("lists the newest first and pages without repeating", async () => {
    const ids = [1, 2, 3].map((hour) =>
      addNotification({ userId: admin.id, createdAt: new Date(`2026-11-05T0${hour}:00:00.000Z`) }),
    );

    const first = await get("/notifications?limit=2&page=1");
    const second = await get("/notifications?limit=2&page=2");

    expect(first.body.data.map((one: { id: string }) => one.id)).toEqual([
      ids[2]!.notificationId,
      ids[1]!.notificationId,
    ]);
    expect(second.body.data.map((one: { id: string }) => one.id)).toEqual([ids[0]!.notificationId]);
    expect(first.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, unreadCount: 3 });
  });

  it("filters the unread ones, and the unread count is over the whole list", async () => {
    addNotification({ userId: admin.id, readAt: new Date("2026-11-05T14:00:00.000Z") });
    const unread = addNotification({ userId: admin.id });

    const only = await get("/notifications?unread=true");
    const all = await get("/notifications?unread=false");

    expect(only.body.data.map((one: { id: string }) => one.id)).toEqual([unread.notificationId]);
    expect(only.body.meta).toMatchObject({ total: 1, unreadCount: 1 });
    expect(all.body.meta).toMatchObject({ total: 2, unreadCount: 1 });
    expect(all.body.data.some((one: { read: boolean }) => one.read)).toBe(true);
  });

  it("lists the read ones too when unread is not asked for", async () => {
    addNotification({ userId: admin.id, readAt: new Date("2026-11-05T14:00:00.000Z") });
    addNotification({ userId: admin.id });

    const res = await get("/notifications");

    expect(res.body.data.map((one: { read: boolean }) => one.read).sort()).toEqual([false, true]);
    expect(res.body.meta).toMatchObject({ total: 2, unreadCount: 1 });
  });

  it("writes each kind with its own title and sentence", async () => {
    addNotification({ userId: admin.id, kind: "SMALL_WORK_DUE_SOON" });

    const res = await get("/notifications");

    expect(res.body.data[0].title.en).toBe("Small work due soon");
    expect(res.body.data[0].body.en).toBe('Villa P-001: "Fix the wall" (Nile Builders) ends on 2026-11-05.');
    expect(res.body.data[0].kind).toBe("SMALL_WORK_DUE_SOON");
  });

  it("keeps the unread count of the whole list when a page is empty", async () => {
    addNotification({ userId: admin.id });

    const res = await get("/notifications?page=5");

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.unreadCount).toBe(1);
  });

  it.each(["unread=yes", "unread=1", "page=0", "limit=1001", "limit=abc"])(
    "refuses %s with 400",
    async (query) => {
      const res = await get(`/notifications?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    },
  );
});

describe("POST /notifications/:id/read", () => {
  it("marks the caller's copy read and answers it", async () => {
    const copy = addNotification({ userId: admin.id });

    const res = await post(`/notifications/${copy.notificationId}/read`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: copy.notificationId, read: true });
    expect(res.body.data.readAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    expect(copy.readAt).toBeInstanceOf(Date);
  });

  it("keeps the first time when it is marked again", async () => {
    const copy = addNotification({ userId: admin.id, readAt: new Date("2026-01-02T03:04:05.000Z") });

    const res = await post(`/notifications/${copy.notificationId}/read`);

    expect(res.status).toBe(200);
    expect(res.body.data.readAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("does not change what another user sees", async () => {
    const id = randomUUID();
    const mine = addNotification({ userId: admin.id, notificationId: id });
    const theirs = addNotification({ userId: employee.id, notificationId: id });

    await post(`/notifications/${id}/read`);

    expect(mine.readAt).not.toBeNull();
    expect(theirs.readAt).toBeNull();
    expect((await get("/notifications", employee)).body.meta.unreadCount).toBe(1);
  });

  it("answers 404 for someone else's notification, the same as for one that does not exist", async () => {
    const theirs = addNotification({ userId: employee.id });

    const others = await post(`/notifications/${theirs.notificationId}/read`);
    const missing = await post(`/notifications/${randomUUID()}/read`);

    for (const res of [others, missing]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOTIFICATION_NOT_FOUND");
    }
    expect(theirs.readAt).toBeNull();
  });

  it("answers the 404 in Arabic on request", async () => {
    const res = await post(`/notifications/${randomUUID()}/read`, admin, "ar");

    expect(res.status).toBe(404);
    expect(res.body.message).not.toBe("Notification not found");
  });

  it("refuses an id that is not a uuid with 400", async () => {
    const res = await post("/notifications/not-a-uuid/read");

    expect(res.status).toBe(400);
  });
});

describe("POST /notifications/read-all", () => {
  it("marks all of the caller's unread notifications and says how many", async () => {
    addNotification({ userId: admin.id });
    addNotification({ userId: admin.id });
    addNotification({ userId: admin.id, readAt: new Date("2026-01-02T03:04:05.000Z") });
    const theirs = addNotification({ userId: employee.id });

    const res = await post("/notifications/read-all");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 2 });
    expect((await get("/notifications")).body.meta.unreadCount).toBe(0);
    expect(theirs.readAt).toBeNull();
  });

  it("answers 0 when there is nothing to mark", async () => {
    const res = await post("/notifications/read-all");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 0 });
  });
});
