import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { maintenanceTables } from "./maintenance-tables.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/maintenance/repository/maintenance.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/maintenance/repository/maintenance.repository.js")
  >()),
  MaintenanceRepository: (await import("./in-memory-maintenance.repository.js"))
    .InMemoryMaintenanceRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  maintenanceTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch" | "delete";
const call = (verb: Verb, path: string) => {
  const agent = request(app);
  return agent[verb](`/api/v1/maintenance${path}`);
};

type Options = { body?: unknown; ifMatch?: string; user?: User; language?: string };
const send = async (verb: Verb, path: string, options: Options = {}) => {
  const req = call(verb, path)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  return options.body === undefined ? req : req.send(options.body as object);
};

const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

const GOOD = {
  villaNumber: "V-101",
  location: "Block 4, Plot 12",
  handoverDate: "2026-08-15",
  issue: "AC leaks water",
};

async function create(body: Record<string, unknown> = {}) {
  const res = await send("post", "", { body: { ...GOOD, ...body } });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number; villaNumber: string };
}

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "maintenance:read"],
    ["get", `/${MISSING_ID}`, "maintenance:read"],
    ["post", "", "maintenance:create"],
    ["patch", `/${MISSING_ID}`, "maintenance:update"],
    ["delete", `/${MISSING_ID}`, "maintenance:delete"],
  ];
  const allCodes = ["maintenance:read", "maintenance:create", "maintenance:update", "maintenance:delete"];

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path).send({});

    expect(res.status).toBe(401);
  });

  it.each(endpoints)(
    "%s %s is not opened by the other maintenance permissions",
    async (verb, path, needed) => {
      const others = allCodes.filter((code) => code !== needed).concat("villas:read", "villas:update");

      const res = await send(verb, path, { user: employee("e@example.test", ...others), body: {} });

      expect(res.status).toBe(403);
    },
  );

  it.each(endpoints)("%s %s lets through the holder of %s", async (verb, path, needed) => {
    const res = await send(verb, path, { user: employee("e@example.test", needed), body: {} });

    expect([401, 403]).not.toContain(res.status);
  });
});

describe("POST /maintenance", () => {
  it("adds a villa typed by hand, open (not solved), and audits it", async () => {
    const res = await send("post", "", { body: { ...GOOD, villaNumber: "  V-101 " } });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      villaNumber: "V-101",
      location: "Block 4, Plot 12",
      handoverDate: "2026-08-15",
      issue: "AC leaks water",
      solved: false,
      solvedAt: null,
      version: 1,
    });
    expect(res.headers.etag).toBe('"1"');
    expect(auditRows().map((row) => row.action)).toEqual(["maintenance.create"]);
    expect(auditRows()[0]).toMatchObject({ entity: "MaintenanceVilla", entityId: res.body.data.id });
  });

  it("does not need the villa to exist, and takes the same villa number twice (two issues)", async () => {
    await create();
    await create({ issue: "Socket burnt" });

    const list = await send("get", "");

    expect(list.body.data).toHaveLength(2);
  });

  it.each([
    [{ villaNumber: "" }, "villaNumber"],
    [{ location: "" }, "location"],
    [{ issue: "" }, "issue"],
    [{ handoverDate: "15/08/2026" }, "handoverDate"],
    [{ handoverDate: undefined }, "handoverDate"],
    [{ extra: true }, ""],
  ])("refuses %j (400)", async (change, path) => {
    const res = await send("post", "", { body: { ...GOOD, ...change } });

    expect(res.status).toBe(400);
    if (path) {
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
    }
    expect(maintenanceTables.rows).toHaveLength(0);
  });
});

describe("GET /maintenance", () => {
  it("lists the open ones with solved=false and the solved ones with solved=true; all without it", async () => {
    const open = await create({ villaNumber: "V-1" });
    const done = await create({ villaNumber: "V-2" });
    await send("patch", `/${done.id}`, { body: { solved: true }, ifMatch: String(done.version) });

    const openList = await send("get", "?solved=false");
    const solvedList = await send("get", "?solved=true");
    const all = await send("get", "");

    expect(openList.body.data.map((r: { id: string }) => r.id)).toEqual([open.id]);
    expect(solvedList.body.data.map((r: { id: string }) => r.id)).toEqual([done.id]);
    expect(all.body.meta.total).toBe(2);
    expect((await send("get", "?solved=maybe")).status).toBe(400);
  });

  it("searches the villa number, the location and the issue, and sorts by handover date (newest first)", async () => {
    await create({ villaNumber: "A-1", handoverDate: "2026-01-01", issue: "Door" });
    await create({ villaNumber: "B-2", handoverDate: "2026-05-01", location: "Near the mosque" });
    await create({ villaNumber: "C-3", handoverDate: "2026-03-01" });

    const sorted = await send("get", "");
    const byMosque = await send("get", "?search=mosque");
    const byDoor = await send("get", "?search=door");

    expect(sorted.body.data.map((r: { villaNumber: string }) => r.villaNumber)).toEqual([
      "B-2",
      "C-3",
      "A-1",
    ]);
    expect(byMosque.body.data.map((r: { villaNumber: string }) => r.villaNumber)).toEqual(["B-2"]);
    expect(byDoor.body.data.map((r: { villaNumber: string }) => r.villaNumber)).toEqual(["A-1"]);
    expect((await send("get", "?sort=villaNumber:asc")).body.data[0].villaNumber).toBe("A-1");
    expect((await send("get", "?sort=issue")).status).toBe(400);
  });
});

describe("PATCH /maintenance/:id", () => {
  it("checking it as solved moves it to the solved list with the time; unchecking moves it back", async () => {
    const item = await create();

    const solved = await send("patch", `/${item.id}`, { body: { solved: true }, ifMatch: '"1"' });

    expect(solved.status).toBe(200);
    expect(solved.body.data.solved).toBe(true);
    expect(new Date(solved.body.data.solvedAt).toISOString()).toBe(solved.body.data.solvedAt);
    expect(solved.body.data.version).toBe(2);

    const back = await send("patch", `/${item.id}`, { body: { solved: false }, ifMatch: '"2"' });

    expect(back.body.data).toMatchObject({ solved: false, solvedAt: null, version: 3 });
    expect(auditRows().map((row) => row.action)).toEqual([
      "maintenance.create",
      "maintenance.solved",
      "maintenance.solved_undo",
    ]);
  });

  it("edits the fields, audited as an update with before and after", async () => {
    const item = await create();

    const res = await send("patch", `/${item.id}`, { body: { issue: "AC fixed, now the door" } });

    expect(res.status).toBe(200);
    expect(res.body.data.issue).toBe("AC fixed, now the door");
    expect(auditRows().at(-1)).toMatchObject({
      action: "maintenance.update",
      before: expect.objectContaining({ issue: "AC leaks water" }),
      after: expect.objectContaining({ issue: "AC fixed, now the door" }),
    });
  });

  it("refuses an old version (409), an empty body (400) and a missing row (404)", async () => {
    const item = await create();
    await send("patch", `/${item.id}`, { body: { solved: true } });

    expect((await send("patch", `/${item.id}`, { body: { solved: false }, ifMatch: '"1"' })).status).toBe(
      409,
    );
    expect((await send("patch", `/${item.id}`, { body: {} })).status).toBe(400);
    const missing = await send("patch", `/${MISSING_ID}`, { body: { solved: true } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("MAINTENANCE_NOT_FOUND");
  });
});

describe("DELETE /maintenance/:id", () => {
  it("deletes it and audits it; a second delete is a 404", async () => {
    const item = await create();

    expect((await send("delete", `/${item.id}`)).status).toBe(204);
    expect(maintenanceTables.rows).toHaveLength(0);
    expect(auditRows().at(-1)).toMatchObject({ action: "maintenance.delete" });
    expect((await send("delete", `/${item.id}`)).status).toBe(404);
  });

  it("answers in Arabic when asked", async () => {
    const res = await send("get", `/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("فيلا الصيانة غير موجودة");
  });
});
