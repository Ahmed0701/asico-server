import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The department overhead on a real PostgreSQL (scratch schema): adding, listing with the salary total, searching and
// sorting, changing and deleting with versions, the audit entries, and the database's own check on the salary.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { OverheadService } from "../../src/modules/overhead/service/overhead.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const admin = { id: "admin", role: "ADMIN" } as never;
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 20, ...extra }) as never;

describe.skipIf(!RUN)("department overhead on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = new OverheadService();

  beforeAll(async () => {
    scratch = await openScratch("scratchoverhead", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',true,now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("adds employees and lists them with how many and their monthly salaries added up", async () => {
    const ahmad = await service.create(admin, { name: "Ahmad", role: "ENGINEER", salaryMinor: 950_000 }, ctx);
    expect(ahmad).toMatchObject({ name: "Ahmad", role: "ENGINEER", salaryMinor: 950_000, version: 1 });
    await service.create(admin, { name: "Bader", role: "OTHER", salaryMinor: 700_500 }, ctx);
    await service.create(admin, { name: "Ziad", role: "DRIVER", salaryMinor: 300_000 }, ctx);

    const all = await service.list(query());
    expect(all.items.map((item) => item.name)).toEqual(["Ahmad", "Bader", "Ziad"]);
    expect(all.totals).toEqual({ count: 3, monthlySalaryMinor: 1_950_500 });

    const bySalary = await service.list(query({ sort: "salary:desc" }));
    expect(bySalary.items.map((item) => item.name)).toEqual(["Ahmad", "Bader", "Ziad"]);
    expect(bySalary.items.map((item) => item.salaryMinor)).toEqual([950_000, 700_500, 300_000]);

    const search = await service.list(query({ search: "oth" }));
    expect(search.items.map((item) => item.name)).toEqual(["Bader"]);
    expect(search.totals).toEqual({ count: 1, monthlySalaryMinor: 700_500 });

    const page = await service.list(query({ limit: 1, page: 2 }));
    expect(page.items.map((item) => item.name)).toEqual(["Bader"]);
    expect(page.totals.count).toBe(3);

    const audit = await q(
      `SELECT "action" FROM "AuditLog" WHERE "entity" = 'OverheadEmployee' ORDER BY "createdAt"`,
    );
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual([
      "overhead.create",
      "overhead.create",
      "overhead.create",
    ]);
  });

  it("changes an employee, keeps what is not sent, and refuses a stale version", async () => {
    const [row] = (await service.list(query({ search: "Ziad" }))).items;
    const changed = await service.update(admin, row!.id, { salaryMinor: 350_000 }, ctx, 1);
    expect(changed).toMatchObject({ name: "Ziad", role: "DRIVER", salaryMinor: 350_000, version: 2 });
    await expect(service.update(admin, row!.id, { role: "WORKER" }, ctx, 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await expect(
      service.update(admin, "00000000-0000-4000-8000-000000000000", { role: "OTHER" }, ctx),
    ).rejects.toMatchObject({
      code: "OVERHEAD_EMPLOYEE_NOT_FOUND",
    });
    const {
      rows: [entry],
    } = await q(
      `SELECT "before","after" FROM "AuditLog" WHERE "action" = 'overhead.update' AND "entityId" = $1`,
      [row!.id],
    );
    expect(entry).toMatchObject({ before: { salaryMinor: 300_000 }, after: { salaryMinor: 350_000 } });
  });

  it("deletes an employee with the right version only", async () => {
    const [row] = (await service.list(query({ search: "Ziad" }))).items;
    await expect(service.remove(admin, row!.id, ctx, 1)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await service.remove(admin, row!.id, ctx, 2);
    await expect(service.get(row!.id, ctx)).rejects.toMatchObject({ code: "OVERHEAD_EMPLOYEE_NOT_FOUND" });
    expect((await service.list(query())).totals).toEqual({ count: 2, monthlySalaryMinor: 1_650_500 });
  });

  it("the database refuses a role that is not in the list on its own", async () => {
    await expect(
      q(
        `INSERT INTO "OverheadEmployee" ("id","name","role","salaryMinor","updatedAt") VALUES ('y','N','Manager',1,now())`,
      ),
    ).rejects.toThrow();
  });

  it("the database refuses a negative salary on its own", async () => {
    await expect(
      q(
        `INSERT INTO "OverheadEmployee" ("id","name","role","salaryMinor","updatedAt") VALUES ('x','N','OTHER',-1,now())`,
      ),
    ).rejects.toThrow();
  });
});
