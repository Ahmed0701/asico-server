import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The alert job and the notification feed on a real PostgreSQL, in a scratch schema that is created for this run and dropped at
// the end. It COMMITS inside the scratch schema, so it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db/small-works-alerts.db.test.ts
//
// What it checks: the SQL that picks the works that are overdue or due soon (against the same rule in TypeScript, minute by
// minute around the Kuwait boundaries); one notification per situation, whatever the number of runs and of instances; who
// receives it; the digest being sent once and retried after a failure; the feed's read state per user; the cascades.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { Mailer } from "../../src/core/mail/index.js";
import { NotificationsRepository } from "../../src/modules/notifications/repository/notifications.repository.js";
import { SmallWorksAlertsRepository } from "../../src/modules/notifications/repository/small-works-alerts.repository.js";
import { NotificationsService } from "../../src/modules/notifications/service/notifications.service.js";
import { SmallWorksAlertsService } from "../../src/modules/notifications/service/small-works-alerts.service.js";
import { alertWindow, deadlineState } from "../../src/shared/utils/deadline.js";

const KUWAIT = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
// A work ending 2026-11-05 is due soon from 13:00Z and overdue from 21:00Z that day (Kuwait is UTC+3 all year).
const IN_WINDOW = new Date("2026-11-05T13:00:00.000Z");
const PAST_DEADLINE = new Date("2026-11-05T21:00:00.000Z");

describe.skipIf(!RUN)("the small work alerts on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  let now = IN_WINDOW;
  let sent: { to: string; subject: string }[] = [];
  let failFor = new Set<string>();
  const mailer = (): Mailer => ({
    async send(message) {
      if (failFor.has(message.to)) {
        throw new Error("smtp down");
      }
      sent.push({ to: message.to, subject: message.subject });
    },
  });
  const service = () =>
    new SmallWorksAlertsService(new SmallWorksAlertsRepository(), () => now, KUWAIT, mailer);
  const feed = new NotificationsService(new NotificationsRepository(), () => now);

  let counter = 0;
  async function addWork(
    extra: { status?: "PENDING" | "DONE"; endDate?: string; villa?: string } = {},
  ): Promise<string> {
    counter += 1;
    const id = `w${counter}`;
    await q(
      `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","status","createdById","updatedAt")
       VALUES ($1,$2,'c1','2020-01-01',$3,$4,$5::"SmallWorkStatus",'admin1',now())`,
      [id, extra.villa ?? "v1", extra.endDate ?? "2026-11-05", `Work ${counter}`, extra.status ?? "PENDING"],
    );
    return id;
  }
  const notifications = async () =>
    (
      await q(
        `SELECT "smallWorkId","kind","endDate"::text AS "endDate","emailedAt" FROM "Notification" ORDER BY "id"`,
      )
    ).rows as { smallWorkId: string; kind: string; endDate: string; emailedAt: Date | null }[];
  const copiesOf = async (userId: string) =>
    (await q(`SELECT "notificationId","readAt" FROM "NotificationRecipient" WHERE "userId"=$1`, [userId]))
      .rows;

  beforeAll(async () => {
    scratch = await openScratch("scratch18b", 8);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin1','Root Admin','a1@x.test','x','ADMIN',true,now()),
       ('reader','Reader','r@x.test','x','EMPLOYEE',true,now()),
       ('reader-off','Gone Reader','roff@x.test','x','EMPLOYEE',false,now()),
       ('other','Other','o@x.test','x','EMPLOYEE',true,now())`,
    );
    await q(`INSERT INTO "Permission" ("id","code") VALUES ('p1','small-works:read'),('p2','villas:read')`);
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") VALUES ('reader','p1'),('reader-off','p1'),('other','p2')`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ('c1','Nile Builders','0100','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
       ('v1','P-001','B1','1','eng','admin1','area',now()), ('v2','P-002','B1','2','eng','admin1','area',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  beforeEach(async () => {
    await q(`DELETE FROM "DailySmallWork"`);
    now = IN_WINDOW;
    sent = [];
    failFor = new Set();
  });

  describe("which works are raised", () => {
    it("raises a DUE_SOON for a pending work in the window, with the facts of the moment", async () => {
      const id = await addWork();

      const result = await service().run();

      expect(result.raised).toEqual({ dueSoon: 1, overdue: 0, openWorksOverdue: 0 });
      expect(await notifications()).toMatchObject([
        { smallWorkId: id, kind: "SMALL_WORK_DUE_SOON", endDate: "2026-11-05" },
      ]);
      const data = (await q(`SELECT "data" FROM "Notification"`)).rows[0]!.data;
      expect(data).toEqual({
        villaNumber: "P-001",
        description: "Work 1",
        contractorName: "Nile Builders",
        endDate: "2026-11-05",
      });
    });

    it("raises nothing a minute before the window", async () => {
      await addWork();
      now = new Date("2026-11-05T12:59:00.000Z");

      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    });

    it("raises OVERDUE from the deadline, and a DUE_SOON that came first stays beside it", async () => {
      await addWork();
      await service().run();
      now = PAST_DEADLINE;

      const result = await service().run();

      expect(result.raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
      expect((await notifications()).map((one) => one.kind).sort()).toEqual([
        "SMALL_WORK_DUE_SOON",
        "SMALL_WORK_OVERDUE",
      ]);
    });

    it("ignores a DONE work, whatever its end date", async () => {
      await addWork({ status: "DONE" });
      await addWork({ status: "DONE", endDate: "2026-01-01" });

      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
      expect(await notifications()).toEqual([]);
    });

    it("agrees with the TypeScript rule, minute by minute around both boundaries", async () => {
      const id = await addWork();
      const repository = new SmallWorksAlertsRepository();
      const tx = scratch.prisma as unknown as Parameters<SmallWorksAlertsRepository["findDue"]>[1];
      for (const start of ["2026-11-05T12:55:00.000Z", "2026-11-05T20:55:00.000Z"]) {
        for (let minute = 0; minute <= 10; minute++) {
          const at = new Date(new Date(start).getTime() + minute * 60_000);
          const window = alertWindow(at, KUWAIT);
          const expected = deadlineState("2026-11-05", true, window, KUWAIT);
          const due = await repository.findDue(window, tx);
          const kind = due.find((one) => one.id === id)?.kind;

          expect(kind, at.toISOString()).toBe(
            expected.overdue ? "SMALL_WORK_OVERDUE" : expected.dueSoon ? "SMALL_WORK_DUE_SOON" : undefined,
          );
        }
      }
    });
  });

  describe("one notification per situation", () => {
    it("raises nothing on a rerun, in the same hour and in the following ones", async () => {
      await addWork();
      await service().run();

      for (const iso of [
        "2026-11-05T13:00:00.000Z",
        "2026-11-05T15:00:00.000Z",
        "2026-11-05T20:59:00.000Z",
      ]) {
        now = new Date(iso);
        expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
      }
      expect(await notifications()).toHaveLength(1);
    });

    it("keeps the situations of two works with the same end date apart", async () => {
      await addWork();
      await service().run();
      await addWork({ villa: "v2" });

      const result = await service().run();

      expect(result.raised).toEqual({ dueSoon: 1, overdue: 0, openWorksOverdue: 0 });
      expect(await notifications()).toHaveLength(2);
    });

    it("raises again for a new end date, and for a work taken back from DONE to PENDING with a different one", async () => {
      const id = await addWork();
      await service().run();
      await q(`UPDATE "DailySmallWork" SET "endDate"='2026-11-06' WHERE "id"=$1`, [id]);
      now = new Date("2026-11-06T13:00:00.000Z");
      expect((await service().run()).raised).toEqual({ dueSoon: 1, overdue: 0, openWorksOverdue: 0 });

      await q(`UPDATE "DailySmallWork" SET "status"='DONE' WHERE "id"=$1`, [id]);
      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
      await q(`UPDATE "DailySmallWork" SET "status"='PENDING' WHERE "id"=$1`, [id]);
      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
      await q(`UPDATE "DailySmallWork" SET "endDate"='2026-11-04' WHERE "id"=$1`, [id]);

      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
      expect(await notifications()).toHaveLength(3);
    });

    it("makes exactly one set of notifications when several instances run at once", async () => {
      for (let index = 0; index < 5; index++) {
        await addWork({ villa: index % 2 === 0 ? "v1" : "v2" });
      }

      const results = await Promise.all([service().run(), service().run(), service().run()]);

      expect(results.reduce((total, one) => total + one.raised.dueSoon, 0)).toBe(5);
      expect(await notifications()).toHaveLength(5);
      const copies = (await q(`SELECT count(*)::int AS n FROM "NotificationRecipient"`)).rows[0]!.n;
      expect(copies).toBe(5 * 2);
      // The digest went out once, whichever instance sent it.
      expect(sent.map((one) => one.to)).toEqual(["a1@x.test"]);
    });

    it("is skipped, and says so, while another connection holds the job's lock", async () => {
      await addWork();
      const holder = await scratch.prisma.$transaction(
        async (tx) => {
          expect(await new SmallWorksAlertsRepository().tryLock(tx)).toBe(true);
          const result = await service().run();
          return result;
        },
        { maxWait: 10_000, timeout: 60_000 },
      );

      expect(holder.skipped).toBe(true);
      expect(await notifications()).toEqual([]);
      expect((await service().run()).raised.dueSoon).toBe(1);
    });
  });

  describe("who receives a notification", () => {
    it("gives a copy to the active admin and each active user who may read small works, and to nobody else", async () => {
      await addWork();

      await service().run();

      expect(await copiesOf("admin1")).toHaveLength(1);
      expect(await copiesOf("reader")).toHaveLength(1);
      expect(await copiesOf("reader-off")).toHaveLength(0);
      expect(await copiesOf("other")).toHaveLength(0);
    });
  });

  describe("the digest email", () => {
    it("goes to the active admin once, and marks the notifications emailed", async () => {
      await addWork();
      await addWork({ endDate: "2026-11-04" });

      const result = await service().run();

      expect(result.digest).toEqual({ notifications: 2, sent: 1, failed: 0 });
      expect(sent.map((one) => one.to)).toEqual(["a1@x.test"]);
      expect((await notifications()).every((one) => one.emailedAt !== null)).toBe(true);
      sent = [];
      expect((await service().run()).digest).toEqual({ notifications: 0, sent: 0, failed: 0 });
      expect(sent).toEqual([]);
    });

    it("is retried by the next run when every send failed, without raising twice", async () => {
      await addWork();
      failFor = new Set(["a1@x.test"]);

      const first = await service().run();

      expect(first.digest).toEqual({ notifications: 1, sent: 0, failed: 1 });
      expect((await notifications())[0]!.emailedAt).toBeNull();
      failFor = new Set();

      const second = await service().run();

      expect(second.raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
      expect(second.digest).toEqual({ notifications: 1, sent: 1, failed: 0 });
    });

    it("leaves out a work that was marked DONE before the digest went", async () => {
      const id = await addWork();
      failFor = new Set(["a1@x.test"]);
      await service().run();
      await q(`UPDATE "DailySmallWork" SET "status"='DONE' WHERE "id"=$1`, [id]);
      failFor = new Set();

      const result = await service().run();

      expect(result.digest).toEqual({ notifications: 0, sent: 0, failed: 0 });
      expect(sent).toEqual([]);
    });
  });

  describe("the feed", () => {
    it("lists a user's own notifications, newest first, with the unread count of the whole list", async () => {
      await addWork();
      await service().run();
      await addWork({ endDate: "2026-11-04" });
      await service().run();

      const page = await feed.list({ id: "reader", role: "EMPLOYEE" }, { page: 1, limit: 1 });

      expect(page.items).toHaveLength(1);
      expect(page.meta).toMatchObject({ total: 2, unreadCount: 2 });
      expect((await feed.list({ id: "other", role: "EMPLOYEE" }, { page: 1, limit: 20 })).items).toEqual([]);
    });

    it("lists the newest first and the oldest last", async () => {
      const first = await addWork();
      await service().run();
      const second = await addWork({ endDate: "2026-11-04" });
      await service().run();
      for (const [work, at] of [
        [first, "2026-11-05 10:00:00+00"],
        [second, "2026-11-05 11:00:00+00"],
      ] as const) {
        await q(
          `UPDATE "NotificationRecipient" SET "createdAt" = $2 WHERE "notificationId" IN (SELECT "id" FROM "Notification" WHERE "smallWorkId" = $1)`,
          [work, at],
        );
      }

      const page = await feed.list({ id: "reader", role: "EMPLOYEE" }, { page: 1, limit: 20 });

      expect(page.items.map((one) => one.entity.id)).toEqual([second, first]);
    });

    it("keeps the read state per user, marks once, and marks all", async () => {
      await addWork();
      await addWork({ endDate: "2026-11-04" });
      await service().run();
      const reader = { id: "reader", role: "EMPLOYEE" } as const;
      const admin = { id: "admin1", role: "ADMIN" } as const;
      const ctx = { locale: "en" } as const;
      const [first] = (await feed.list(reader, { page: 1, limit: 20 })).items;

      const read = await feed.markRead(reader, first!.id, ctx);
      now = new Date("2026-11-06T00:00:00.000Z");
      const again = await feed.markRead(reader, first!.id, ctx);

      expect(read.read).toBe(true);
      expect(read.readAt).toBe(IN_WINDOW.toISOString());
      expect(again.readAt).toBe(read.readAt);
      expect((await feed.list(reader, { page: 1, limit: 20 })).meta.unreadCount).toBe(1);
      expect((await feed.list(admin, { page: 1, limit: 20 })).meta.unreadCount).toBe(2);
      expect((await feed.list(reader, { page: 1, limit: 20, unread: true })).items).toHaveLength(1);
      expect(await feed.markAllRead(reader)).toEqual({ updated: 1 });
      expect(await feed.markAllRead(reader)).toEqual({ updated: 0 });
      expect((await feed.list(admin, { page: 1, limit: 20 })).meta.unreadCount).toBe(2);
    });

    it("answers 404 for a notification the user has no copy of", async () => {
      await addWork();
      await service().run();
      const [first] = (await feed.list({ id: "reader", role: "EMPLOYEE" }, { page: 1, limit: 20 })).items;

      await expect(
        feed.markRead({ id: "other", role: "EMPLOYEE" }, first!.id, { locale: "en" }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOTIFICATION_NOT_FOUND" });
    });
  });

  describe("the cascades", () => {
    it("deletes the notifications and their copies with the small work", async () => {
      const id = await addWork();
      await service().run();

      await q(`DELETE FROM "DailySmallWork" WHERE "id"=$1`, [id]);

      expect(await notifications()).toEqual([]);
      expect((await q(`SELECT count(*)::int AS n FROM "NotificationRecipient"`)).rows[0]!.n).toBe(0);
    });

    it("deletes a user's copies with the user and leaves the others'", async () => {
      await q(
        `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('temp','T','t@x.test','x','EMPLOYEE',true,now())`,
      );
      await q(`INSERT INTO "UserPermission" ("userId","permissionId") VALUES ('temp','p1')`);
      await addWork();
      await service().run();
      expect(await copiesOf("temp")).toHaveLength(1);

      await q(`DELETE FROM "User" WHERE "id"='temp'`);

      expect(await copiesOf("temp")).toHaveLength(0);
      expect(await copiesOf("reader")).toHaveLength(1);
      expect(await notifications()).toHaveLength(1);
    });
  });
});
