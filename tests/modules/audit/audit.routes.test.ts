import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addDocument } from "../villa-documents/in-memory-villa-documents.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { addAuditRow } from "./in-memory-audit.repository.js";
import { KNOWN_ACTIONS } from "../../../src/modules/audit/dto/actions.js";
import { ENTITY_LABEL_KEYS } from "../../../src/modules/audit/dto/entities.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("../auth/in-memory-auth.repository.js")).InMemoryAuthRepository,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("../users/in-memory-users.repository.js")).InMemoryUsersRepository,
}));
vi.mock("../../../src/modules/permissions/repository/permissions.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/permissions/repository/permissions.repository.js")
  >()),
  PermissionsRepository: (await import("../permissions/in-memory-permissions.repository.js"))
    .InMemoryPermissionsRepository,
}));
vi.mock("../../../src/modules/audit/repository/audit.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/audit/repository/audit.repository.js")>()),
  AuditRepository: (await import("./in-memory-audit.repository.js")).InMemoryAuditRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const PASSWORD = "Correct-Horse-9";
const logId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MISSING_ID = randomUUID();

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

let admin: User;
beforeEach(() => {
  store.reset();
  permissionTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash, role: "ADMIN" });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, name: string, ...codes: string[]): User {
  const user = store.addUser({ name, email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

const get = async (path: string, language = "en", headers?: { Authorization: string }) =>
  request(app)
    .get(`/api/v1${path}`)
    .set(headers ?? (await as(admin)))
    .set("Accept-Language", language);

const ids = (res: request.Response): string[] => res.body.data.map((item: { id: string }) => item.id);

describe("access control", () => {
  const endpoints = ["/audit-logs", "/audit-logs/filters", `/audit-logs/${MISSING_ID}`];

  it.each(endpoints)("GET %s requires authentication (401)", async (path) => {
    const res = await request(app).get(`/api/v1${path}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it.each(endpoints)(
    "GET %s answers 403 to an employee without audit:read, in Arabic on request",
    async (path) => {
      const res = await get(path, "ar", await as(employee("e@example.test", "E")));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)("GET %s is not opened by any other permission", async (path) => {
    const others = employee(
      "e@example.test",
      "E",
      "users:read",
      "users:update",
      "permissions:assign",
      "dashboard:read",
    );

    expect((await get(path, "en", await as(others))).status).toBe(403);
  });

  it.each(endpoints)("GET %s lets through the holder of audit:read and the ADMIN", async (path) => {
    const reader = await get(path, "en", await as(employee("e@example.test", "E", "audit:read")));
    const root = await get(path);

    expect([401, 403]).not.toContain(reader.status);
    expect([401, 403]).not.toContain(root.status);
  });

  it("checks access before validating the query", async () => {
    const res = await get("/audit-logs?limit=99999", "en", await as(employee("e@example.test", "E")));

    expect(res.status).toBe(403);
  });
});

describe("GET /audit-logs", () => {
  let alice: User;
  let bob: User;

  beforeEach(() => {
    alice = employee("alice@example.test", "Alice Smith");
    bob = employee("bob@example.test", "Bob Jones");
    const at = (iso: string) => new Date(iso);
    addAuditRow({
      id: logId(1),
      createdAt: at("2026-01-10T08:00:00.000Z"),
      actorId: alice.id,
      action: "auth.login",
      entity: "User",
      entityId: alice.id,
      ip: "10.0.0.1",
      userAgent: "UA/1",
      requestId: "req-1",
    });
    addAuditRow({
      id: logId(2),
      createdAt: at("2026-01-10T09:00:00.000Z"),
      actorId: admin.id,
      action: "user.create",
      entity: "User",
      entityId: bob.id,
      after: { email: "bob@example.test" },
    });
    addAuditRow({
      id: logId(3),
      createdAt: at("2026-01-11T09:00:00.000Z"),
      actorId: admin.id,
      action: "user.update",
      entity: "User",
      entityId: bob.id,
      before: { name: "Old" },
      after: { name: "New", passwordHash: "leaked-hash" },
    });
    addAuditRow({
      id: logId(4),
      createdAt: at("2026-01-12T00:00:00.000Z"),
      actorId: null,
      action: "user.deactivate",
      entity: "User",
    });
    addAuditRow({
      id: logId(5),
      createdAt: at("2026-01-12T00:00:00.000Z"),
      actorId: alice.id,
      action: "auth.logout",
      entity: "User",
    });
    addAuditRow({
      id: logId(6),
      createdAt: at("2026-01-31T23:59:59.999Z"),
      actorId: bob.id,
      action: "auth.login",
      entity: "User",
    });
    addAuditRow({
      id: logId(7),
      createdAt: at("2026-02-01T00:00:00.000Z"),
      actorId: bob.id,
      action: "auth.login",
      entity: "User",
    });
  });

  const expectIds = (res: request.Response, ...numbers: number[]): void => {
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(numbers.map(logId));
  };

  it("returns the newest first, ties broken by id, with the shared pagination meta", async () => {
    const res = await get("/audit-logs");

    expectIds(res, 7, 6, 4, 5, 3, 2, 1);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 7, totalPages: 1 });
  });

  it("returns the documented item shape, with the actor joined and no before or after", async () => {
    const res = await get("/audit-logs?actorId=" + alice.id + "&action=auth.login");

    expect(res.body.data).toEqual([
      {
        id: logId(1),
        actor: { id: alice.id, name: "Alice Smith", email: "alice@example.test" },
        action: "auth.login",
        actionLabel: "Signed in",
        entity: "User",
        entityCode: "User",
        entityId: alice.id,
        entityName: "Alice Smith",
        entityDetail: "alice@example.test",
        ip: "10.0.0.1",
        userAgent: "UA/1",
        requestId: "req-1",
        createdAt: "2026-01-10T08:00:00.000Z",
      },
    ]);
    expect(JSON.stringify((await get("/audit-logs")).body)).not.toMatch(/"before"|"after"|leaked-hash/);
  });

  it("reports a missing actor as null instead of failing", async () => {
    const res = await get("/audit-logs?action=user.deactivate");

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: logId(4),
      actor: null,
      entityId: null,
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });

  it("shows every time as a UTC ISO string", async () => {
    const res = await get("/audit-logs");

    for (const item of res.body.data) {
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  describe("pagination", () => {
    it("pages with limit and page", async () => {
      expectIds(await get("/audit-logs?limit=2&page=2"), 4, 5);
      expect((await get("/audit-logs?limit=2&page=2")).body.meta).toEqual({
        page: 2,
        limit: 2,
        total: 7,
        totalPages: 4,
      });
      expectIds(await get("/audit-logs?limit=2&page=4"), 1);
      expectIds(await get("/audit-logs?limit=2&page=5"));
    });

    it("accepts a limit of 1000 and rejects 1001 with 400 instead of clamping, in Arabic", async () => {
      expect((await get("/audit-logs?limit=1000")).status).toBe(200);

      const res = await get("/audit-logs?limit=1001", "ar");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
      expect(res.body.details[0].path).toBe("limit");
    });

    it.each(["0", "-1", "abc", "1.5", ""])("rejects limit=%j with 400", async (value) => {
      expect((await get(`/audit-logs?limit=${value}`, "ar")).status).toBe(400);
    });

    it.each(["0", "-1", "abc"])("rejects page=%j with 400", async (value) => {
      expect((await get(`/audit-logs?page=${value}`)).status).toBe(400);
    });
  });

  describe("filters", () => {
    it("by actorId", async () => {
      expectIds(await get(`/audit-logs?actorId=${alice.id}`), 5, 1);
      expectIds(await get(`/audit-logs?actorId=${randomUUID()}`));
    });

    it("by action, exactly", async () => {
      expectIds(await get("/audit-logs?action=auth.login"), 7, 6, 1);
      expectIds(await get("/audit-logs?action=auth.log"));
    });

    it("by entity, exactly", async () => {
      expect((await get("/audit-logs?entity=User")).body.meta.total).toBe(7);
      expect((await get("/audit-logs?entity=user")).body.meta.total).toBe(0);
      expect((await get("/audit-logs?entity=Villa")).body.meta.total).toBe(0);
    });

    it("by entityId", async () => {
      expectIds(await get(`/audit-logs?entityId=${bob.id}`), 3, 2);
    });

    it("by a date range where a date alone means the whole UTC day, ends included", async () => {
      expectIds(await get("/audit-logs?from=2026-01-12"), 7, 6, 4, 5);
      expectIds(await get("/audit-logs?to=2026-01-10"), 2, 1);
      expectIds(await get("/audit-logs?from=2026-02-01&to=2026-02-01"), 7);
      expectIds(await get("/audit-logs?to=2026-01-31"), 6, 4, 5, 3, 2, 1);
      expectIds(await get("/audit-logs?from=2026-01-10&to=2026-01-10"), 2, 1);
    });

    it("by a date and time, inclusive at both ends, with offsets converted to UTC", async () => {
      expectIds(await get("/audit-logs?from=2026-01-31T23:59:59.999Z"), 7, 6);
      expectIds(await get("/audit-logs?to=2026-01-31T23:59:59.998Z"), 4, 5, 3, 2, 1);
      expectIds(await get(`/audit-logs?from=${encodeURIComponent("2026-01-12T02:00:00+02:00")}`), 7, 6, 4, 5);
    });

    it("rejects from after to with 400, translated, on the to field", async () => {
      const res = await get("/audit-logs?from=2026-02-01&to=2026-01-31", "ar");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "to", message: "يجب ألا يكون تاريخ النهاية قبل تاريخ البداية" },
      ]);
    });

    it.each(["2026-02-30", "31/01/2026", "yesterday", "2026-01-31T10:00:00"])(
      "rejects the invalid date %j with 400, translated",
      async (value) => {
        const res = await get(`/audit-logs?from=${encodeURIComponent(value)}`, "ar");

        expect(res.status).toBe(400);
        expect(res.body.details[0]).toMatchObject({ path: "from" });
        expect(res.body.details[0].message).toContain("أدخل تاريخًا صالحًا");
      },
    );

    it("rejects an actorId that is not a uuid", async () => {
      const res = await get("/audit-logs?actorId=alice", "ar");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ path: "actorId", message: "معرّف غير صالح" }]);
    });

    it("searches action or entity, case-insensitively", async () => {
      expectIds(await get("/audit-logs?search=LOGIN"), 7, 6, 1);
      expectIds(await get("/audit-logs?search=deact"), 4);
      expect((await get("/audit-logs?search=uSeR")).body.meta.total).toBe(7);
      expectIds(await get("/audit-logs?search=nothing"));
      expect((await get(`/audit-logs?search=${"x".repeat(101)}`)).status).toBe(400);
    });

    it("combines filters with AND", async () => {
      expectIds(await get(`/audit-logs?actorId=${alice.id}&action=auth.login`), 1);
      expectIds(await get(`/audit-logs?actorId=${bob.id}&search=login&from=2026-02-01`), 7);
      expectIds(
        await get(`/audit-logs?actorId=${admin.id}&entityId=${bob.id}&to=2026-01-10&sort=createdAt:asc`),
        2,
      );
    });

    it("rejects text filters longer than 100 characters", async () => {
      for (const name of ["action", "entity", "entityId"]) {
        expect((await get(`/audit-logs?${name}=${"x".repeat(101)}`)).status).toBe(400);
      }
    });
  });

  describe("sort", () => {
    it("sorts by createdAt in either direction, oldest-first being the only change", async () => {
      expectIds(await get("/audit-logs?sort=createdAt:asc"), 1, 2, 3, 4, 5, 6, 7);
      expectIds(await get("/audit-logs?sort=createdAt:desc"), 7, 6, 4, 5, 3, 2, 1);
      expectIds(await get("/audit-logs?sort=createdAt"), 1, 2, 3, 4, 5, 6, 7);
    });

    it("pages stably through entries that share a timestamp", async () => {
      const first = await get("/audit-logs?limit=1&page=3");
      const second = await get("/audit-logs?limit=1&page=4");

      expect([...ids(first), ...ids(second)]).toEqual([logId(4), logId(5)]);
    });

    it.each(["action", "id:asc", "actor:desc", "createdAt:up", "createdAt:asc:x", ":asc"])(
      "rejects sort=%j with 400 and a translated message",
      async (sort) => {
        const res = await get(`/audit-logs?sort=${encodeURIComponent(sort)}`, "ar");

        expect(res.status).toBe(400);
        expect(res.body.details[0].path).toBe("sort");
        expect(res.body.details[0].message).toContain("ترتيب غير صالح");
      },
    );
  });

  it("ignores query parameters it does not know", async () => {
    expect((await get("/audit-logs?foo=bar")).status).toBe(200);
  });
});

describe("the user an entry is about", () => {
  it("is shown by name and email, in the list and in the detail, in both languages", async () => {
    const sara = store.addUser({
      name: "Sara Ali",
      email: "sara@example.test",
      passwordHash: "x",
      role: "EMPLOYEE",
    });
    const row = addAuditRow({ action: "auth.login", entity: "User", entityId: sara.id });

    for (const language of ["en", "ar"]) {
      const list = await get("/audit-logs?limit=100", language);
      const detail = await get(`/audit-logs/${row.id}`, language);

      expect(list.body.data.find((item: { id: string }) => item.id === row.id)).toMatchObject({
        entityName: "Sara Ali",
        entityDetail: "sara@example.test",
      });
      expect(detail.body.data).toMatchObject({ entityName: "Sara Ali", entityDetail: "sara@example.test" });
    }
  });

  it("is still shown by name and email when the user is gone, from the entry's own snapshot", async () => {
    const row = addAuditRow({
      action: "user.update",
      entity: "User",
      entityId: "user-gone",
      before: { name: "Old", email: "old@example.test" },
      after: { name: "Sara Ali", email: "sara@example.test" },
    });

    const res = await get(`/audit-logs/${row.id}`);

    expect(res.body.data).toMatchObject({ entityName: "Sara Ali", entityDetail: "sara@example.test" });
  });

  it("has no detail on the entry of anything else", async () => {
    addAuditRow({
      action: "contractor.create",
      entity: "Contractor",
      entityId: "c-gone",
      after: { name: "Nile" },
    });

    const res = await get("/audit-logs?limit=100");

    expect(
      res.body.data.every((item: { entity: string; entityDetail: string | null }) =>
        item.entity === "User" ? true : item.entityDetail === null,
      ),
    ).toBe(true);
  });
});

describe("GET /audit-logs/:id", () => {
  it("returns the full record: actor, before and after", async () => {
    const actor = employee("e@example.test", "Ed Actor");
    const row = addAuditRow({
      id: logId(1),
      createdAt: new Date("2026-01-11T09:00:00.000Z"),
      actorId: actor.id,
      action: "user.update",
      entity: "User",
      entityId: "user-9",
      ip: "10.0.0.1",
      userAgent: "UA/1",
      requestId: "req-9",
      before: { name: "Old" },
      after: { name: "New" },
    });

    const res = await get(`/audit-logs/${row.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: logId(1),
      actor: { id: actor.id, name: "Ed Actor", email: "e@example.test" },
      action: "user.update",
      actionLabel: "Updated a user",
      entity: "User",
      entityCode: "User",
      entityId: "user-9",
      // No such user any more, so the name comes from the entry's own snapshot.
      entityName: "New",
      // The snapshot holds no email.
      entityDetail: null,
      ip: "10.0.0.1",
      userAgent: "UA/1",
      requestId: "req-9",
      createdAt: "2026-01-11T09:00:00.000Z",
      before: { name: "Old" },
      after: { name: "New" },
    });
  });

  it("masks sensitive values that slipped into before or after, keeping the keys", async () => {
    addAuditRow({
      id: logId(1),
      actorId: admin.id,
      action: "user.update",
      entity: "User",
      before: { passwordHash: "$2b$12$leak", sessions: [{ tokenHash: "abc", id: 1 }] },
      after: { name: "N", nested: { Authorization: "Bearer x", cookie: "sid=1", client_secret: "s" } },
    });

    const res = await get(`/audit-logs/${logId(1)}`);

    expect(res.body.data.before).toEqual({
      passwordHash: "[REDACTED]",
      sessions: [{ tokenHash: "[REDACTED]", id: 1 }],
    });
    expect(res.body.data.after).toEqual({
      name: "N",
      nested: { Authorization: "[REDACTED]", cookie: "[REDACTED]", client_secret: "[REDACTED]" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/\$2b\$|Bearer x|sid=1|"abc"/);
  });

  it("returns null for absent before and after and for a missing actor", async () => {
    addAuditRow({ id: logId(1), actorId: null, action: "user.deactivate", entity: "User" });

    const res = await get(`/audit-logs/${logId(1)}`);

    expect(res.body.data).toMatchObject({ actor: null, before: null, after: null });
  });

  it("answers 404 AUDIT_LOG_NOT_FOUND for an unknown id, in Arabic on request", async () => {
    const res = await get(`/audit-logs/${MISSING_ID}`, "ar");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "AUDIT_LOG_NOT_FOUND", message: "سجل التدقيق غير موجود" });
  });

  it("answers 400 for something that is not an id", async () => {
    const res = await get("/audit-logs/not-a-uuid", "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("GET /audit-logs/filters", () => {
  it("is not mistaken for an id", async () => {
    const res = await get("/audit-logs/filters");

    expect(res.status).toBe(200);
    // Nothing is logged, but everything the application knows can still be chosen.
    expect(res.body.data.actions).toEqual([...KNOWN_ACTIONS]);
    expect(res.body.data.entities).toEqual(Object.keys(ENTITY_LABEL_KEYS).sort());
    expect(res.body.data.actors).toEqual([]);
    expect(Object.keys(res.body.data).sort()).toEqual([
      "actionLabels",
      "actions",
      "actors",
      "entities",
      "entityLabels",
    ]);
  });

  it("lists the distinct actions and entities present, sorted, and only actors that have logs", async () => {
    const alice = employee("alice@example.test", "Alice Smith");
    employee("carol@example.test", "Carol Without Logs");
    addAuditRow({ actorId: alice.id, action: "user.update", entity: "User" });
    addAuditRow({ actorId: alice.id, action: "auth.login", entity: "User" });
    addAuditRow({ actorId: admin.id, action: "auth.login", entity: "User" });
    addAuditRow({ actorId: null, action: "villa.create", entity: "Villa" });

    const res = await get("/audit-logs/filters");

    // Every known action and entity is offered (with or without an entry); the three logged here are among them.
    expect(res.body.data.actions).toEqual([...KNOWN_ACTIONS]);
    expect(res.body.data.entities).toEqual(Object.keys(ENTITY_LABEL_KEYS).sort());
    expect(res.body.data.actors).toEqual([
      { id: alice.id, name: "Alice Smith" },
      { id: admin.id, name: "Root Admin" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("email");
  });

  it("returns at most 100 actors", async () => {
    for (let i = 0; i < 105; i++) {
      const user = employee(`user${i}@example.test`, `User ${String(i).padStart(3, "0")}`);
      addAuditRow({ actorId: user.id, action: "auth.login", entity: "User" });
    }

    const res = await get("/audit-logs/filters");

    expect(res.body.data.actors).toHaveLength(100);
    const names = res.body.data.actors.map((actor: { name: string }) => actor.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("read-only", () => {
  it.each(["post", "put", "patch", "delete"] as const)(
    "%s on the audit routes answers 404 and changes nothing",
    async (verb) => {
      addAuditRow({
        id: logId(1),
        actorId: admin.id,
        action: "user.create",
        entity: "User",
        after: { a: 1 },
      });
      const before = JSON.stringify(store.auditRows);
      const header = await as(admin);

      for (const path of ["/audit-logs", `/audit-logs/${logId(1)}`, "/audit-logs/filters"]) {
        const res = await request(app)[verb](`/api/v1${path}`).set(header).send({ action: "tampered" });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
      }
      expect(JSON.stringify(store.auditRows)).toBe(before);
    },
  );
});

describe("admin accountability", () => {
  const cookieOf = (res: request.Response): string => {
    const header = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("refresh_token="),
    );
    return (header ?? "").split(";")[0] ?? "";
  };

  it("records everything the ADMIN does with the ADMIN as actor, readable through the audit API", async () => {
    // A stranger signs up first: that entry must belong to them, not to the ADMIN.
    const signup = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Stranger", email: "stranger@example.test", password: PASSWORD });
    const requestIds: [string, string][] = [];
    const track = (action: string, res: request.Response): void => {
      requestIds.push([action, String(res.headers["x-request-id"])]);
    };

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: admin.email, password: PASSWORD });
    track("auth.login", login);
    const header = { Authorization: `Bearer ${login.body.data.accessToken as string}` };
    const cookie = cookieOf(login);

    const created = await request(app)
      .post("/api/v1/users")
      .set(header)
      .send({
        name: "New Hire",
        email: "hire@example.test",
        password: PASSWORD,
        permissions: ["villas:read"],
      });
    track("user.create", created);
    const hireId = created.body.data.id as string;

    track(
      "user.profile_updated",
      await request(app).patch("/api/v1/me").set(header).send({ name: "Root Admin II" }),
    );
    track("user.deactivate", await request(app).patch(`/api/v1/users/${hireId}/deactivate`).set(header));
    track("user.activate", await request(app).patch(`/api/v1/users/${hireId}/activate`).set(header));
    track(
      "user.permissions_replaced",
      await request(app)
        .put(`/api/v1/users/${hireId}/permissions`)
        .set(header)
        .send({ permissions: ["users:read"] }),
    );
    track(
      "auth.password_changed",
      await request(app)
        .post("/api/v1/auth/change-password")
        .set(header)
        .set("Cookie", cookie)
        .send({ currentPassword: PASSWORD, newPassword: "Another-Pass-22" }),
    );
    track("auth.logout", await request(app).post("/api/v1/auth/logout").set("Cookie", cookie));

    const trail = await get(`/audit-logs?actorId=${admin.id}&sort=createdAt:asc&limit=100`);

    expect(trail.status).toBe(200);
    expect(trail.body.data.map((item: { action: string }) => item.action).sort()).toEqual(
      requestIds.map(([action]) => action).sort(),
    );
    for (const item of trail.body.data) {
      // The actor is joined when read, so the whole trail shows the ADMIN's current name (renamed above).
      expect(item.actor).toEqual({ id: admin.id, name: "Root Admin II", email: "root@example.test" });
      expect(item.ip).toEqual(expect.any(String));
      expect(item.requestId).toBe(requestIds.find(([action]) => action === item.action)?.[1]);
      expect(item.createdAt).toMatch(/Z$/);
    }

    // The sequence of calls is the sequence in time: login, then everything else, logout last.
    const times = requestIds.map(([action]) =>
      new Date(
        trail.body.data.find((item: { action: string }) => item.action === action).createdAt,
      ).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // The signup belongs to the stranger and is not in the ADMIN's trail.
    const signups = await get("/audit-logs?action=auth.signup");
    expect(signups.body.data).toHaveLength(1);
    expect(signups.body.data[0].actor).toMatchObject({
      id: signup.body.data.user.id,
      email: "stranger@example.test",
    });
    expect(trail.body.data.some((item: { action: string }) => item.action === "auth.signup")).toBe(false);

    // The detail shows what changed, with no secrets.
    const createdEntry = trail.body.data.find((item: { action: string }) => item.action === "user.create");
    const detail = await get(`/audit-logs/${createdEntry.id}`);
    expect(detail.body.data.after).toMatchObject({
      email: "hire@example.test",
      role: "EMPLOYEE",
      permissions: ["villas:read"],
    });
    const replaced = await get(
      `/audit-logs/${trail.body.data.find((item: { action: string }) => item.action === "user.permissions_replaced").id}`,
    );
    expect(replaced.body.data).toMatchObject({
      before: { permissions: ["villas:read"] },
      after: { permissions: ["users:read"] },
      entityId: hireId,
    });
    const everything =
      JSON.stringify((await get("/audit-logs?limit=1000")).body) +
      JSON.stringify(detail.body) +
      JSON.stringify(replaced.body);
    expect(everything).not.toMatch(new RegExp(`${PASSWORD}|Another-Pass-22|\\$2b\\$|passwordHash`));

    // Both people show up in the filter dropdown.
    const options = await get("/audit-logs/filters");
    expect(options.body.data.actors.map((actor: { name: string }) => actor.name).sort()).toEqual(
      ["Root Admin II", "Stranger"].sort(),
    );
    expect(options.body.data.actions).toEqual(
      expect.arrayContaining(["auth.login", "auth.logout", "user.create", "auth.signup"]),
    );
  });
});

describe("the entity, in the language of the request, and the name of what an entry is about", () => {
  beforeEach(() => {
    villaTables.reset();
    contractorTables.reset();
    engineerTables.reset();
  });

  const entry = async (language: string, query = "") => {
    const res = await get(`/audit-logs?limit=100${query}`, language);
    return res.body.data as {
      id: string;
      entity: string;
      entityCode: string;
      entityId: string | null;
      entityName: string | null;
      action: string;
    }[];
  };

  it.each([
    ["User", "User", "مستخدم"],
    ["Villa", "Villa", "فيلا"],
    ["Contractor", "Contractor", "مقاول"],
    ["CivilEngineer", "Civil engineer", "مهندس مدني"],
    ["VillaDocument", "Villa document", "مستند الفيلا"],
    ["AuditLog", "Audit log", "سجل التدقيق"],
  ])(
    "%s is shown as %j with Accept-Language en and %j with ar, and keeps its code",
    async (code, english, arabic) => {
      addAuditRow({ action: "x", entity: code });

      const [en] = await entry("en");
      const [ar] = await entry("ar");

      expect(en).toMatchObject({ entity: english, entityCode: code });
      expect(ar).toMatchObject({ entity: arabic, entityCode: code });
    },
  );

  it("is English when the language is anything but Arabic, or missing", async () => {
    addAuditRow({ action: "x", entity: "Contractor" });

    for (const language of ["en", "en-US", "fr", "de-DE,en;q=0.8", ""]) {
      expect((await entry(language))[0], language).toMatchObject({ entity: "Contractor" });
    }
    expect((await entry("ar-EG"))[0]).toMatchObject({ entity: "مقاول" });
  });

  it("an entity it does not know is left as it is, in both languages", async () => {
    addAuditRow({ action: "x", entity: "Widget", entityId: "w1" });

    for (const language of ["en", "ar"]) {
      expect((await entry(language))[0]).toMatchObject({
        entity: "Widget",
        entityCode: "Widget",
        entityName: null,
        entityDetail: null,
      });
    }
  });

  it("only the entity label changes between the languages: everything else, names included, is the same", async () => {
    const villa = addVilla({ villaNumber: "P-777", civilEngineerId: "e" });
    addAuditRow({ action: "villa.create", entity: "Villa", entityId: villa.id, actorId: admin.id });
    addAuditRow({ action: "auth.login", entity: "User", entityId: admin.id, actorId: admin.id });

    const strip = (rows: Awaited<ReturnType<typeof entry>>) =>
      rows.map((row) => ({ ...row, entity: undefined, actionLabel: undefined }));

    expect(strip(await entry("ar"))).toEqual(strip(await entry("en")));
  });

  describe("entityName", () => {
    it("is a villa's number", async () => {
      const villa = addVilla({ villaNumber: "P-777", civilEngineerId: "e" });
      addAuditRow({ action: "villa.create", entity: "Villa", entityId: villa.id });

      expect((await entry("en"))[0]?.entityName).toBe("P-777");
      expect((await entry("ar"))[0]?.entityName).toBe("P-777");
    });

    it("is a contractor's, a civil engineer's and a user's name, and a file's original name", async () => {
      const contractor = addContractor({ name: "شركة النيل" });
      const engineer = addEngineer({ name: "Mona Hassan" });
      const user = employee("sara@example.test", "Sara");
      const villa = addVilla({ villaNumber: "P-1", civilEngineerId: engineer.id });
      const file = addDocument({ villaId: villa.id, originalName: "site plan.pdf" });
      addAuditRow({ action: "contractor.create", entity: "Contractor", entityId: contractor.id });
      addAuditRow({ action: "civil_engineer.create", entity: "CivilEngineer", entityId: engineer.id });
      addAuditRow({ action: "auth.login", entity: "User", entityId: user.id });
      addAuditRow({ action: "villa_document.upload", entity: "VillaDocument", entityId: file.id });

      const byEntity = Object.fromEntries((await entry("ar")).map((row) => [row.entityCode, row.entityName]));

      expect(byEntity).toEqual({
        Contractor: "شركة النيل",
        CivilEngineer: "Mona Hassan",
        User: "Sara",
        VillaDocument: "site plan.pdf",
      });
    });

    it("is the record's name now, even when the entry's own snapshot holds only the fields that changed", async () => {
      const villa = addVilla({ villaNumber: "P-NOW", civilEngineerId: "e" });
      addAuditRow({
        action: "villa.update",
        entity: "Villa",
        entityId: villa.id,
        before: { status: "OPEN" },
        after: { status: "CLOSED" },
      });

      expect((await entry("en"))[0]?.entityName).toBe("P-NOW");
    });

    it("comes from the entry's snapshot when the record is gone: a delete's before", async () => {
      addAuditRow({
        action: "villa.delete",
        entity: "Villa",
        entityId: "deleted-villa",
        before: { villaNumber: "P-DEL", status: "OPEN" },
      });
      addAuditRow({
        action: "contractor.delete",
        entity: "Contractor",
        entityId: "deleted-contractor",
        before: { name: "Old Contractor", phone: "0100" },
      });

      const names = Object.fromEntries((await entry("en")).map((row) => [row.action, row.entityName]));

      expect(names).toEqual({ "villa.delete": "P-DEL", "contractor.delete": "Old Contractor" });
    });

    it("is null when the record is gone and the snapshot has no name", async () => {
      addAuditRow({
        action: "villa.update",
        entity: "Villa",
        entityId: "deleted-villa",
        before: { status: "OPEN" },
        after: { status: "CLOSED" },
      });

      expect((await entry("en"))[0]?.entityName).toBeNull();
    });

    it("is null for an entry about no particular record (an export)", async () => {
      addAuditRow({
        action: "export.villas",
        entity: "Villa",
        after: { format: "pdf", filters: {}, rowCount: 3 },
      });

      expect((await entry("en"))[0]).toMatchObject({ entityId: null, entityName: null });
    });

    it("follows a rename: it is the name the record has now", async () => {
      const contractor = addContractor({ name: "Old Name" });
      addAuditRow({
        action: "contractor.create",
        entity: "Contractor",
        entityId: contractor.id,
        after: { name: "Old Name" },
      });

      contractor.name = "New Name";

      expect((await entry("en"))[0]?.entityName).toBe("New Name");
    });

    it("never leaks anything but the name from the snapshot", async () => {
      addAuditRow({
        action: "contractor.delete",
        entity: "Contractor",
        entityId: "gone",
        before: { name: "Old Contractor", phone: "0100 123 4567", secret: "leaked-secret" },
      });

      const body = JSON.stringify((await get("/audit-logs")).body);

      expect(body).toContain("Old Contractor");
      expect(body).not.toMatch(/leaked-secret|0100 123 4567|"before"|"after"/);
    });
  });

  describe("the detail", () => {
    it("has the label, the code and the name, in the language of the request", async () => {
      const villa = addVilla({ villaNumber: "P-9", civilEngineerId: "e" });
      const row = addAuditRow({
        action: "villa.update",
        entity: "Villa",
        entityId: villa.id,
        before: { status: "OPEN" },
        after: { status: "CLOSED" },
      });

      const ar = await get(`/audit-logs/${row.id}`, "ar");
      const en = await get(`/audit-logs/${row.id}`, "en");

      expect(ar.body.data).toMatchObject({ entity: "فيلا", entityCode: "Villa", entityName: "P-9" });
      expect(en.body.data).toMatchObject({ entity: "Villa", entityCode: "Villa", entityName: "P-9" });
      expect(ar.body.data).toMatchObject({ before: { status: "OPEN" }, after: { status: "CLOSED" } });
    });

    it("takes the name from its own snapshot when the record is gone", async () => {
      const row = addAuditRow({
        action: "contractor.delete",
        entity: "Contractor",
        entityId: "gone",
        before: { name: "Old Contractor" },
      });

      expect((await get(`/audit-logs/${row.id}`, "ar")).body.data).toMatchObject({
        entity: "مقاول",
        entityName: "Old Contractor",
      });
    });
  });

  describe("the filter options", () => {
    it("keep the raw entity codes in the array and add a label for each, in the request language", async () => {
      addAuditRow({ action: "a", entity: "User" });
      addAuditRow({ action: "a", entity: "CivilEngineer" });
      addAuditRow({ action: "a", entity: "Widget" });

      const en = (await get("/audit-logs/filters", "en")).body.data;
      const ar = (await get("/audit-logs/filters", "ar")).body.data;

      // The codes the application knows, and the one only the log holds (Widget), each once.
      expect(en.entities).toEqual([...Object.keys(ENTITY_LABEL_KEYS), "Widget"].sort());
      expect(ar.entities).toEqual(en.entities);
      expect(en.entityLabels).toMatchObject({
        CivilEngineer: "Civil engineer",
        User: "User",
        Widget: "Widget",
      });
      expect(ar.entityLabels).toMatchObject({
        CivilEngineer: "مهندس مدني",
        User: "مستخدم",
        Widget: "Widget",
      });
    });

    it("have a label for exactly the codes in the array", async () => {
      for (const entity of ["User", "Villa", "VillaDocument"]) addAuditRow({ action: "a", entity });

      const { entities, entityLabels } = (await get("/audit-logs/filters", "ar")).body.data;

      expect(Object.keys(entityLabels).sort()).toEqual([...entities].sort());
    });
  });

  describe("filtering still works on the code, whatever the language", () => {
    it("?entity= takes the raw code; the Arabic label matches nothing", async () => {
      addAuditRow({ action: "a", entity: "Villa" });
      addAuditRow({ action: "b", entity: "User" });

      expect((await entry("ar", "&entity=Villa")).map((r) => r.action)).toEqual(["a"]);
      expect((await entry("en", "&entity=Villa")).map((r) => r.action)).toEqual(["a"]);
      expect(await entry("ar", `&entity=${encodeURIComponent("فيلا")}`)).toEqual([]);
    });
  });

  describe("entries written before the villa rename (legacy Project and ProjectFile codes)", () => {
    it.each([
      ["Project", "Villa", "فيلا", "Villa"],
      ["ProjectFile", "Villa document", "مستند الفيلا", "VillaDocument"],
    ])(
      "%s is labelled as today's entity in both languages, and keeps its stored code",
      async (code, english, arabic) => {
        addAuditRow({ action: "project.create", entity: code });

        expect((await entry("en"))[0]).toMatchObject({ entity: english, entityCode: code });
        expect((await entry("ar"))[0]).toMatchObject({ entity: arabic, entityCode: code });
      },
    );

    it("a legacy project entry is named by the projectNumber in its own snapshot once the record is gone", async () => {
      addAuditRow({
        action: "project.delete",
        entity: "Project",
        entityId: "old-project",
        before: { projectNumber: "P-OLD-1", plotNumber: "7" },
      });

      expect((await entry("en"))[0]?.entityName).toBe("P-OLD-1");
    });

    it("a legacy project entry shows the villa's current number while the same id still exists", async () => {
      const villa = addVilla({ villaNumber: "V-NOW", civilEngineerId: "e" });
      addAuditRow({
        action: "project.update",
        entity: "Project",
        entityId: villa.id,
        after: { projectNumber: "P-THEN" },
      });

      expect((await entry("en"))[0]?.entityName).toBe("V-NOW");
    });

    it("a legacy file entry is named by the original name in its snapshot", async () => {
      addAuditRow({
        action: "project_file.delete",
        entity: "ProjectFile",
        entityId: "old-file",
        before: { originalName: "plan.pdf" },
      });

      expect((await entry("en"))[0]?.entityName).toBe("plan.pdf");
    });

    it("?entity=Villa matches both Villa and legacy Project entries, and nothing else", async () => {
      addAuditRow({ action: "villa.create", entity: "Villa" });
      addAuditRow({ action: "project.create", entity: "Project" });
      addAuditRow({ action: "project_file.upload", entity: "ProjectFile" });
      addAuditRow({ action: "contractor.create", entity: "Contractor" });

      expect((await entry("en", "&entity=Villa")).map((r) => r.action).sort()).toEqual([
        "project.create",
        "villa.create",
      ]);
    });

    it("?entity=VillaDocument matches both VillaDocument and legacy ProjectFile entries", async () => {
      addAuditRow({ action: "villa_document.upload", entity: "VillaDocument" });
      addAuditRow({ action: "project_file.upload", entity: "ProjectFile" });
      addAuditRow({ action: "project.create", entity: "Project" });

      expect((await entry("en", "&entity=VillaDocument")).map((r) => r.action).sort()).toEqual([
        "project_file.upload",
        "villa_document.upload",
      ]);
    });

    it("?entity=Project (the old code) still finds the same entries as Villa", async () => {
      addAuditRow({ action: "villa.create", entity: "Villa" });
      addAuditRow({ action: "project.create", entity: "Project" });

      expect((await entry("en", "&entity=Project")).map((r) => r.action).sort()).toEqual([
        "project.create",
        "villa.create",
      ]);
    });

    it("the filter options fold the legacy codes into the entity they stand for, once", async () => {
      for (const entity of ["Villa", "Project", "ProjectFile", "VillaDocument", "Project"]) {
        addAuditRow({ action: "a", entity });
      }

      const { entities, entityLabels } = (await get("/audit-logs/filters", "en")).body.data;

      // Each once, and no legacy code of its own.
      expect(entities).toEqual(Object.keys(ENTITY_LABEL_KEYS).sort());
      expect(entities).not.toContain("Project");
      expect(entities).not.toContain("ProjectFile");
      expect(entityLabels).toMatchObject({ Villa: "Villa", VillaDocument: "Villa document" });
    });
  });

  describe("caching", () => {
    it.each(["/audit-logs", "/audit-logs/filters"])(
      "%s says the answer depends on Accept-Language",
      async (path) => {
        const res = await get(path, "ar");

        expect(res.headers["vary"]).toMatch(/Accept-Language/i);
      },
    );

    it("errors say so too", async () => {
      const res = await request(app).get("/api/v1/audit-logs");

      expect(res.status).toBe(401);
      expect(res.headers["vary"]).toMatch(/Accept-Language/i);
    });
  });
});

describe("the action, by label and by code", () => {
  const items = async (path: string, language = "en") =>
    (await get(path, language)).body.data as { action: string; actionLabel: string }[];

  it("an entry carries its action code and what it means, in the language of the request", async () => {
    addAuditRow({ action: "villa.mew_follow_up", entity: "Villa" });

    expect(await items("/audit-logs")).toMatchObject([
      { action: "villa.mew_follow_up", actionLabel: "Put a villa on MEW follow up" },
    ]);
    expect(await items("/audit-logs", "ar")).toMatchObject([
      { action: "villa.mew_follow_up", actionLabel: "إضافة فيلا إلى متابعة الوزارة (MEW)" },
    ]);
  });

  it("an action it does not know keeps its code as its label, in both languages", async () => {
    addAuditRow({ action: "widget.explode", entity: "Widget" });

    expect(await items("/audit-logs", "en")).toMatchObject([
      { action: "widget.explode", actionLabel: "widget.explode" },
    ]);
    expect(await items("/audit-logs", "ar")).toMatchObject([
      { action: "widget.explode", actionLabel: "widget.explode" },
    ]);
  });

  it("the detail carries the label too", async () => {
    const row = addAuditRow({ action: "export.open-works", entity: "WorkItem" });

    const { data } = (await get(`/audit-logs/${row.id}`, "ar")).body;

    expect(data).toMatchObject({ action: "export.open-works", actionLabel: "تصدير الأعمال المفتوحة" });
  });

  describe("entries written before the villa rename", () => {
    it("are labelled as the action they stand for, and keep their stored code", async () => {
      addAuditRow({ action: "project.update", entity: "Project" });
      addAuditRow({ action: "project_file.upload", entity: "ProjectFile" });
      addAuditRow({ action: "export.projects", entity: "Project" });

      const rows = await items("/audit-logs");

      expect(rows.map((row) => [row.action, row.actionLabel]).sort()).toEqual([
        ["export.projects", "Exported villas"],
        ["project.update", "Updated a villa"],
        ["project_file.upload", "Uploaded a villa document"],
      ]);
    });

    it("an action of a retired feature has its own label", async () => {
      addAuditRow({ action: "project.material_request_update", entity: "Project" });

      expect(await items("/audit-logs", "ar")).toMatchObject([
        { actionLabel: "تعديل طلب مواد (ميزة ملغاة)" },
      ]);
    });

    it("?action= takes either code and finds the entries of both", async () => {
      addAuditRow({ action: "villa.create", entity: "Villa" });
      addAuditRow({ action: "project.create", entity: "Project" });
      addAuditRow({ action: "villa.update", entity: "Villa" });

      for (const code of ["villa.create", "project.create"]) {
        expect((await items(`/audit-logs?action=${code}`)).map((row) => row.action).sort()).toEqual([
          "project.create",
          "villa.create",
        ]);
      }
    });

    it("an action with no legacy code still matches exactly", async () => {
      addAuditRow({ action: "villa.update", entity: "Villa" });
      addAuditRow({ action: "villa.create", entity: "Villa" });

      expect((await items("/audit-logs?action=villa.update")).map((row) => row.action)).toEqual([
        "villa.update",
      ]);
    });
  });

  describe("the filter options", () => {
    it("offer every known action, each with its label, in the language of the request", async () => {
      const en = (await get("/audit-logs/filters", "en")).body.data;
      const ar = (await get("/audit-logs/filters", "ar")).body.data;

      expect(en.actions).toEqual([...KNOWN_ACTIONS]);
      expect(ar.actions).toEqual(en.actions);
      expect(Object.keys(en.actionLabels).sort()).toEqual([...en.actions].sort());
      expect(en.actionLabels["export.daily-labour"]).toBe("Exported daily labour");
      expect(ar.actionLabels["export.daily-labour"]).toBe("تصدير العمالة اليومية");
      // A retired action is offered only while the log holds an entry written with it.
      expect(en.actions).not.toContain("open_work.auto_sync");
    });

    it("add the codes only the log holds, once each, and fold the legacy ones into the action they stand for", async () => {
      for (const action of ["project.create", "villa.create", "project.create", "export.projects"]) {
        addAuditRow({ action, entity: "Villa" });
      }
      addAuditRow({ action: "widget.explode", entity: "Widget" });
      addAuditRow({ action: "project.material_request_update", entity: "Project" });
      addAuditRow({ action: "export.wall-piping", entity: "WallPiping" });

      const { actions, actionLabels } = (await get("/audit-logs/filters", "en")).body.data;

      expect(actions).toEqual(
        [...KNOWN_ACTIONS, "widget.explode", "project.material_request_update", "export.wall-piping"].sort(),
      );
      expect(actions).not.toContain("project.create");
      expect(actions).not.toContain("export.projects");
      expect(actionLabels["widget.explode"]).toBe("widget.explode");
      expect(actionLabels["export.wall-piping"]).toBe("Exported wall piping (a retired feature)");
    });
  });
});
