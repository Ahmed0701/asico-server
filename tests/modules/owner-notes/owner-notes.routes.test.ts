import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { ownerNoteTables } from "./owner-notes-tables.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/owner-notes/repository/owner-notes.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/owner-notes/repository/owner-notes.repository.js")
  >()),
  OwnerNotesRepository: (await import("./in-memory-owner-notes.repository.js")).InMemoryOwnerNotesRepository,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();

let admin: User;
let villa: StoredVilla;
let other: StoredVilla;
beforeEach(() => {
  store.reset();
  engineerTables.reset();
  villaTables.reset();
  ownerNoteTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  villa = addVilla({
    villaNumber: "V-101",
    block: "4",
    plot: "12",
    area: "New Cairo",
    ownerName: "Abu Khaled",
  });
  other = addVilla({ villaNumber: "V-202", block: "7", plot: "3", area: "Zayed", ownerName: "Umm Salem" });
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
type Options = { body?: unknown; ifMatch?: string; user?: User; language?: string };
const send = async (verb: Verb, path: string, options: Options = {}) => {
  const agent = request(app);
  const req = agent[verb](`/api/v1/owner-notes${path}`)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  return options.body === undefined ? req : req.send(options.body as object);
};

const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

async function create(body: Record<string, unknown> = {}) {
  const res = await send("post", "", {
    body: { villaId: villa.id, notes: "Wants the AC outlet moved", ...body },
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number };
}

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "owner-notes:read"],
    ["get", `/${MISSING_ID}`, "owner-notes:read"],
    ["post", "", "owner-notes:create"],
    ["patch", `/${MISSING_ID}`, "owner-notes:update"],
    ["delete", `/${MISSING_ID}`, "owner-notes:delete"],
  ];

  it.each(endpoints)("%s %s needs %s", async (verb, path, code) => {
    const others = [
      "owner-notes:read",
      "owner-notes:create",
      "owner-notes:update",
      "owner-notes:delete",
    ].filter((one) => one !== code);
    const user = employee("someone@example.test", ...others);

    expect((await send(verb, path, { user, body: {} })).status).toBe(403);
  });

  it("refuses a request without a token with 401", async () => {
    expect((await request(app).get("/api/v1/owner-notes")).status).toBe(401);
  });
});

describe("POST /owner-notes", () => {
  it("adds an open note for a villa, with its number, location and owner from the villa, and audits it", async () => {
    const res = await send("post", "", {
      body: { villaId: villa.id, notes: "  Wants the AC outlet moved " },
    });

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      villa: { id: villa.id, villaNumber: "V-101", location: "New Cairo . 4 . 12" },
      ownerName: "Abu Khaled",
      notes: "Wants the AC outlet moved",
      done: false,
      doneAt: null,
      version: 1,
    });
    expect(auditRows().at(-1)).toMatchObject({
      action: "owner_note.create",
      entity: "OwnerNote",
      after: { villaNumber: "V-101", notes: "Wants the AC outlet moved", doneAt: null },
    });
  });

  it("refuses a villa that does not exist with 404 VILLA_NOT_FOUND, and saves nothing", async () => {
    const res = await send("post", "", { body: { villaId: MISSING_ID, notes: "x" } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(ownerNoteTables.rows).toHaveLength(0);
  });

  it("refuses empty notes, a typed owner name (it is the villa's) and unknown fields with 400", async () => {
    for (const body of [
      { villaId: villa.id, notes: "   " },
      { villaId: villa.id },
      { villaId: villa.id, ownerName: "Someone", notes: "x" },
      { villaId: villa.id, notes: "x", done: true },
      { villaId: "not-an-id", notes: "x" },
    ]) {
      expect((await send("post", "", { body })).status).toBe(400);
    }
    expect(ownerNoteTables.rows).toHaveLength(0);
  });
});

describe("GET /owner-notes", () => {
  it("lists the open ones with done=false and the done ones with done=true; all without it", async () => {
    const open = await create();
    const finished = await create({ notes: "Paint the gate" });
    await send("patch", `/${finished.id}`, { body: { done: true } });

    const ids = async (query: string) =>
      ((await send("get", query)).body.data as { id: string }[]).map((one) => one.id).sort();

    expect(await ids("?done=false")).toEqual([open.id]);
    expect(await ids("?done=true")).toEqual([finished.id]);
    expect(await ids("")).toEqual([open.id, finished.id].sort());
  });

  it("searches the villa number, the owner name and the notes; filters by villa; sorts by villa number", async () => {
    await create({ notes: "Move the meter" });
    await create({ villaId: other.id, notes: "Extra socket" });

    const numbers = async (query: string) =>
      ((await send("get", query)).body.data as { villa: { villaNumber: string } }[]).map(
        (one) => one.villa.villaNumber,
      );

    expect(await numbers("?search=salem")).toEqual(["V-202"]);
    expect(await numbers("?search=meter")).toEqual(["V-101"]);
    expect(await numbers("?search=v-2")).toEqual(["V-202"]);
    expect(await numbers(`?villaId=${other.id}`)).toEqual(["V-202"]);
    expect(await numbers("?sort=villaNumber:desc")).toEqual(["V-202", "V-101"]);
    expect((await send("get", "?sort=notes")).status).toBe(400);
  });
});

describe("PATCH /owner-notes/:id", () => {
  it("checking it as done moves it to the done list with the time; unchecking moves it back", async () => {
    const note = await create();

    const done = await send("patch", `/${note.id}`, { body: { done: true }, ifMatch: '"1"' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ done: true, version: 2 });
    expect(done.body.data.doneAt).toEqual(expect.any(String));

    const back = await send("patch", `/${note.id}`, { body: { done: false } });
    expect(back.body.data).toMatchObject({ done: false, doneAt: null, version: 3 });
    expect(auditRows().map((row) => row["action"])).toEqual([
      "owner_note.create",
      "owner_note.done",
      "owner_note.done_undo",
    ]);
  });

  it("edits the villa and the notes (the owner follows the villa), audited as an update with before and after", async () => {
    const note = await create();

    const res = await send("patch", `/${note.id}`, {
      body: { villaId: other.id, notes: "New text" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      villa: { villaNumber: "V-202" },
      ownerName: "Umm Salem",
      notes: "New text",
    });
    expect(auditRows().at(-1)).toMatchObject({
      action: "owner_note.update",
      before: { villaNumber: "V-101", notes: "Wants the AC outlet moved" },
      after: { villaNumber: "V-202", notes: "New text" },
    });
  });

  it("shows the villa's current owner: renaming the owner on the villa shows on its notes, and no owner is null", async () => {
    const note = await create();
    villa.ownerName = "Abu Fahad";
    const renamed = await send("get", `/${note.id}`);
    villa.ownerName = null;
    const none = await send("get", `/${note.id}`);

    expect(renamed.body.data.ownerName).toBe("Abu Fahad");
    expect(none.body.data.ownerName).toBeNull();
    expect((await send("patch", `/${note.id}`, { body: { ownerName: "X" } })).status).toBe(400);
  });

  it("refuses an old version (409), an empty body (400), a missing villa (404) and a missing note (404)", async () => {
    const note = await create();

    expect((await send("patch", `/${note.id}`, { body: { notes: "x" }, ifMatch: '"7"' })).status).toBe(409);
    expect((await send("patch", `/${note.id}`, { body: {} })).status).toBe(400);
    const noVilla = await send("patch", `/${note.id}`, { body: { villaId: MISSING_ID } });
    expect(noVilla.status).toBe(404);
    expect(noVilla.body.code).toBe("VILLA_NOT_FOUND");
    const missing = await send("patch", `/${MISSING_ID}`, { body: { notes: "x" } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("OWNER_NOTE_NOT_FOUND");
  });
});

describe("DELETE /owner-notes/:id", () => {
  it("deletes it and audits it; a second delete is a 404", async () => {
    const note = await create();

    expect((await send("delete", `/${note.id}`, { ifMatch: '"1"' })).status).toBe(204);
    expect(auditRows().at(-1)).toMatchObject({
      action: "owner_note.delete",
      before: { villaNumber: "V-101" },
    });
    expect((await send("delete", `/${note.id}`)).status).toBe(404);
  });

  it("answers in Arabic when asked", async () => {
    const res = await send("get", `/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("ملاحظة المالك غير موجودة");
  });
});

describe("a villa with owner notes", () => {
  it("is not deleted: 409 VILLA_HAS_RECORDS", async () => {
    await create();

    const res = await request(app)
      .delete(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VILLA_HAS_RECORDS");
  });
});
