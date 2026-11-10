import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import { DashboardRepository } from "../../../src/modules/dashboard/repository/dashboard.repository.js";
import type { DayRange } from "../../../src/modules/dashboard/dto/dashboard.dto.js";

// The queries are tagged templates (the strings, then the values) or a Prisma.Sql; both are recorded as the text with a `?` for
// each value, which the driver numbers. These pin the words of the new counting queries, since a
// changed comparison is a one-character edit in a string. What the queries DO is run on a real database in tests/db.
function recorder(rows: unknown[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray | Prisma.Sql, ...params: unknown[]) => {
      const [text, values] = Array.isArray(query)
        ? [(query as unknown as TemplateStringsArray).join("?"), params]
        : [(query as Prisma.Sql).sql, (query as Prisma.Sql).values];
      calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
      return rows;
    }),
  } as unknown as Prisma.TransactionClient;
  return { db, calls };
}

const range: DayRange = {
  today: new Date("2026-10-12T00:00:00.000Z"),
  until: new Date("2026-11-11T00:00:00.000Z"),
  weekStart: new Date("2026-10-06T00:00:00.000Z"),
};
const repository = new DashboardRepository();

describe("the open works counters", () => {
  it("count by status, and the overdue ones by the list's own rule", async () => {
    const { db, calls } = recorder([{ total: 2n, notStarted: 1n }]);

    expect(await repository.openWorkCounters(range.today, db)).toEqual({ total: 2n, notStarted: 1n });

    expect(calls).toEqual([
      {
        text:
          `SELECT count(*) AS "total", ` +
          `count(*) FILTER (WHERE w."status" = 'NOT_STARTED') AS "notStarted", ` +
          `count(*) FILTER (WHERE w."status" = 'IN_PROGRESS') AS "inProgress", ` +
          `count(*) FILTER (WHERE w."status" = 'DELAYED') AS "delayed", ` +
          `count(*) FILTER (WHERE w."status" = 'DONE') AS "done", ` +
          `count(*) FILTER (WHERE w."endDate" < ?::date AND w."status" <> 'DONE') AS "overdue" ` +
          `FROM "WorkItem" w`,
        values: ["2026-10-12"],
      },
    ]);
  });

  it("use the very predicate the open works list uses for overdue", async () => {
    const { OpenWorksRepository } =
      await import("../../../src/modules/open-works/repository/open-works.repository.js");
    const listing = recorder([{ id: "x" }]);
    await new OpenWorksRepository()
      .list(
        {
          filters: { overdue: true },
          sort: { field: "endDate", direction: "asc" },
          today: range.today,
          skip: 0,
          take: 1,
        },
        listing.db,
      )
      .catch(() => undefined);

    const predicate = `"endDate" < ?::date AND `;
    const listSql = listing.calls.map((call) => call.text).join(" ");
    expect(listSql).toContain(`${predicate}w."status" <> 'DONE'`);
  });
});

describe("the daily reports counters", () => {
  it("count today's reports, and the window that ends with today", async () => {
    const { db, calls } = recorder([{ today: 1n, last7Days: 2n }]);

    expect(await repository.dailyReportCounters(range, db)).toEqual({ today: 1n, last7Days: 2n });

    expect(calls).toEqual([
      {
        text:
          `SELECT count(*) FILTER (WHERE r."reportDate" = ?::date) AS "today", ` +
          `count(*) FILTER ( WHERE r."reportDate" >= ?::date AND r."reportDate" <= ?::date ) AS "last7Days" ` +
          `FROM "DailyReport" r`,
        values: ["2026-10-12", "2026-10-06", "2026-10-12"],
      },
    ]);
  });
});

describe("the small works counters", () => {
  const window = { today: "2026-11-05", horizon: "2026-11-06" };

  it("counts all of them and the pending ones, over all time, and those due soon and overdue by the two days of the window", async () => {
    const { db, calls } = recorder([{ total: 9n, pending: 3n, dueSoon: 2n, overdue: 1n }]);

    expect(await repository.smallWorkCounters(window, db)).toEqual({
      total: 9n,
      pending: 3n,
      dueSoon: 2n,
      overdue: 1n,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["2026-11-05", "2026-11-06", "2026-11-05"]);
    expect(calls[0]!.text).toContain(
      `w."status" = 'PENDING' AND w."endDate" >= ?::date AND w."endDate" < ?::date`,
    );
    expect(calls[0]!.text).toContain(`w."status" = 'PENDING' AND w."endDate" < ?::date`);
  });

  it("lists the most urgent pending ones: earliest end date first, up to the limit", async () => {
    const { db, calls } = recorder([]);

    await repository.smallWorkUrgent(window, 5, db);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["2026-11-06", 5]);
    expect(calls[0]!.text).toContain(`w."status" = 'PENDING' AND w."endDate" < ?::date`);
    expect(calls[0]!.text).toContain(`ORDER BY w."endDate" ASC, w."createdAt" ASC, w."id" ASC LIMIT ?`);
  });
});

describe("the site reports counter", () => {
  it("counts the reports and adds up the ratings, over all time", async () => {
    const { db, calls } = recorder([{ total: 2n, ratingSum: 9n }]);

    expect(await repository.siteReportCounters(db)).toEqual({ total: 2n, ratingSum: 9n });

    expect(calls).toEqual([
      {
        text: `SELECT count(*) AS "total", COALESCE(sum(r."rating"), 0) AS "ratingSum" FROM "SiteReport" r`,
        values: [],
      },
    ]);
  });
});

describe("the labour counters", () => {
  it("add up the labour counts of today and of the window that ends with today", async () => {
    const { db, calls } = recorder([{ today: 5n, last7Days: 9n, total: 42n }]);

    expect(await repository.labourCounters(range, db)).toEqual({ today: 5n, last7Days: 9n, total: 42n });

    expect(calls).toEqual([
      {
        text:
          `SELECT COALESCE(sum(l."labourCount") FILTER (WHERE l."labourDate" = ?::date), 0) AS "today", ` +
          `COALESCE(sum(l."labourCount") FILTER ( WHERE l."labourDate" >= ?::date AND l."labourDate" <= ?::date ), 0) AS "last7Days", ` +
          `COALESCE(sum(l."labourCount"), 0) AS "total" ` +
          `FROM "DailyLabour" l`,
        values: ["2026-10-12", "2026-10-06", "2026-10-12"],
      },
    ]);
  });
});

describe("every counting query answers exactly one row", () => {
  it.each([
    ["open works", (db: Prisma.TransactionClient) => repository.openWorkCounters(range.today, db)],
    ["daily reports", (db: Prisma.TransactionClient) => repository.dailyReportCounters(range, db)],
    [
      "small works",
      (db: Prisma.TransactionClient) =>
        repository.smallWorkCounters({ today: "2026-11-05", horizon: "2026-11-06" }, db),
    ],
    ["site reports", (db: Prisma.TransactionClient) => repository.siteReportCounters(db)],
    ["labour", (db: Prisma.TransactionClient) => repository.labourCounters(range, db)],
  ])("%s: no row is an error, not a silent zero", async (name, run) => {
    await expect(run(recorder([]).db)).rejects.toThrow(`the ${name} counters query returned no row`);
  });

  it("the older villa and progress queries are as strict", async () => {
    await expect(repository.villaCounters(range, recorder([]).db)).rejects.toThrow(
      "the villa counters query returned no row",
    );
    await expect(repository.progressCounters(recorder([]).db)).rejects.toThrow(
      "the progress counters query returned no row",
    );
  });
});

describe("the granted codes", () => {
  it("are the codes of the user's grants", async () => {
    const findMany = vi.fn(async () => [
      { permission: { code: "villas:read" } },
      { permission: { code: "audit:read" } },
    ]);
    const db = { userPermission: { findMany } } as unknown as Prisma.TransactionClient;

    expect(await repository.grantedCodes("u1", db)).toEqual(["villas:read", "audit:read"]);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { permission: { select: { code: true } } },
    });
  });
});
