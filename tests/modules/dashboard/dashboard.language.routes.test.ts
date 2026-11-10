import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAuditRow } from "../audit/in-memory-audit.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/dashboard/repository/dashboard.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/dashboard/repository/dashboard.repository.js")
  >()),
  DashboardRepository: (await import("./in-memory-dashboard.repository.js")).InMemoryDashboardRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
let admin: User;

beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  engineerTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

afterEach(() => {
  vi.useRealTimers();
});

const recent = async (language?: string, limit = 50) => {
  const req = request(app)
    .get(`/api/v1/dashboard/recent-activity?limit=${limit}`)
    .set({ Authorization: `Bearer ${await signAccessToken({ id: admin.id, role: admin.role })}` });
  const res = await (language === undefined ? req : req.set("Accept-Language", language));
  return res;
};

type Item = {
  id: string;
  action: string;
  entity: string;
  entityCode: string;
  entityId: string | null;
  entityName: string | null;
};
const items = (res: request.Response): Item[] => res.body.data;
const minute = (n: number): Date => new Date(Date.UTC(2026, 9, 12, 10, n));

describe("GET /dashboard/recent-activity: the entity in the language of the request", () => {
  it.each([
    ["User", "User", "مستخدم"],
    ["Villa", "Villa", "فيلا"],
    ["Contractor", "Contractor", "مقاول"],
    ["CivilEngineer", "Civil engineer", "مهندس مدني"],
    ["VillaDocument", "Villa document", "مستند الفيلا"],
    ["AuditLog", "Audit log", "سجل التدقيق"],
  ])("%s is %j with Accept-Language en and %j with ar", async (code, english, arabic) => {
    addAuditRow({ action: "x", entity: code, createdAt: minute(1) });

    expect(items(await recent("en"))[0]).toMatchObject({ entity: english, entityCode: code });
    expect(items(await recent("ar"))[0]).toMatchObject({ entity: arabic, entityCode: code });
  });

  it("is English with no Accept-Language header at all", async () => {
    addAuditRow({ action: "x", entity: "Contractor", createdAt: minute(1) });

    expect(items(await recent())[0]).toMatchObject({ entity: "Contractor" });
  });

  it("leaves an entity it does not know as it is", async () => {
    addAuditRow({ action: "x", entity: "Widget", createdAt: minute(1) });

    expect(items(await recent("ar"))[0]).toMatchObject({ entity: "Widget", entityCode: "Widget" });
  });

  it("answers the way the request's language says on the very same data, both ways in turn", async () => {
    addAuditRow({ action: "x", entity: "Villa", createdAt: minute(1) });

    const first = items(await recent("ar"))[0]?.entity;
    const second = items(await recent("en"))[0]?.entity;
    const third = items(await recent("ar"))[0]?.entity;

    expect([first, second, third]).toEqual(["فيلا", "Villa", "فيلا"]);
  });

  it("says the answer depends on Accept-Language", async () => {
    expect((await recent("ar")).headers["vary"]).toMatch(/Accept-Language/i);
  });
});

describe("GET /dashboard/recent-activity: the name of what an entry is about", () => {
  it("is a villa's number, and names a villa created a moment ago", async () => {
    const villa = addVilla({ villaNumber: "P-2026-014", civilEngineerId: "e" });
    addAuditRow({
      action: "villa.create",
      entity: "Villa",
      entityId: villa.id,
      actorId: admin.id,
      createdAt: minute(1),
    });

    expect(items(await recent("ar"))[0]).toMatchObject({
      action: "villa.create",
      entity: "فيلا",
      entityId: villa.id,
      entityName: "P-2026-014",
    });
  });

  it("is the name of a contractor, an engineer or a user", async () => {
    const contractor = addContractor({ name: "شركة النيل" });
    const engineer = addEngineer({ name: "Mona Hassan" });
    addAuditRow({
      action: "contractor.create",
      entity: "Contractor",
      entityId: contractor.id,
      createdAt: minute(1),
    });
    addAuditRow({
      action: "civil_engineer.create",
      entity: "CivilEngineer",
      entityId: engineer.id,
      createdAt: minute(2),
    });
    addAuditRow({
      action: "auth.login",
      entity: "User",
      entityId: admin.id,
      actorId: admin.id,
      createdAt: minute(3),
    });

    const names = Object.fromEntries(items(await recent("en")).map((i) => [i.entityCode, i.entityName]));

    expect(names).toEqual({ Contractor: "شركة النيل", CivilEngineer: "Mona Hassan", User: "Root Admin" });
  });

  it("is the same in both languages: a name is not translated", async () => {
    const contractor = addContractor({ name: "Nile Builders" });
    addAuditRow({
      action: "contractor.create",
      entity: "Contractor",
      entityId: contractor.id,
      createdAt: minute(1),
    });

    expect(items(await recent("en"))[0]?.entityName).toBe("Nile Builders");
    expect(items(await recent("ar"))[0]?.entityName).toBe("Nile Builders");
  });

  it("comes from the entry's own snapshot for a record that has been deleted", async () => {
    addAuditRow({
      action: "villa.delete",
      entity: "Villa",
      entityId: "gone",
      before: { villaNumber: "P-DELETED", status: "OPEN" },
      createdAt: minute(1),
    });

    expect(items(await recent("ar"))[0]).toMatchObject({ entityName: "P-DELETED" });
  });

  it("is null when there is nothing to name: an export, a deleted record whose snapshot has no name", async () => {
    addAuditRow({
      action: "export.villas",
      entity: "Villa",
      after: { format: "xlsx" },
      createdAt: minute(1),
    });
    addAuditRow({
      action: "villa.update",
      entity: "Villa",
      entityId: "gone",
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
      createdAt: minute(2),
    });

    expect(items(await recent("en")).map((i) => i.entityName)).toEqual([null, null]);
  });

  it("is always present as a field, null or a string, and never leaks before or after", async () => {
    const villa = addVilla({ villaNumber: "P-1", civilEngineerId: "e" });
    addAuditRow({
      action: "villa.update",
      entity: "Villa",
      entityId: villa.id,
      before: { secret: "before-value" },
      after: { secret: "after-value" },
      createdAt: minute(1),
    });
    addAuditRow({ action: "x", entity: "Widget", createdAt: minute(2) });

    const res = await recent("en");

    for (const item of items(res)) expect(item).toHaveProperty("entityName");
    expect(JSON.stringify(res.body)).not.toMatch(/secret|"before"|"after"/);
  });

  it("has exactly the documented fields", async () => {
    addAuditRow({ action: "x", entity: "User", createdAt: minute(1) });

    expect(Object.keys(items(await recent("en"))[0] ?? {})).toEqual([
      "id",
      "actor",
      "action",
      "actionLabel",
      "entity",
      "entityCode",
      "entityId",
      "entityName",
      "entityDetail",
      "ip",
      "userAgent",
      "requestId",
      "createdAt",
    ]);
  });
});
