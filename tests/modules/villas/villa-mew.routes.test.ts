import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addVilla, villaTables, type StoredVilla } from "./in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("./in-memory-villas.repository.js")).InMemoryVillasRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

// The MEW follow-up page: the two MEW marks (follow-up and inspection, each a time and a user, set and taken off by a
// person) and the villa's two MEW states.
const app = createApp();

let admin: User;
let villa: StoredVilla;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  villaTables.reset();
  phaseTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  villa = addVilla({ villaNumber: "P-001" });
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
type Options = { language?: string; body?: unknown; ifMatch?: string; user?: User };
const send = async (verb: Verb, path: string, options: Options = {}) => {
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  return options.body === undefined ? req : req.send(options.body as object);
};
const live = (): StoredVilla => villaTables.villas.find((candidate) => candidate.id === villa.id)!;
// Both MEW files are approved: a villa can be added for MEW inspection only then.
const submitted = { mewAcState: "APPROVED", mewElecState: "APPROVED" } as const;
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

// [name, path, field in the answer, audit action, code when it is already on, code when it is not on]
describe.each([
  [
    "MEW follow-up",
    "mew-follow-up",
    "mewFollowUp",
    "villa.mew_follow_up",
    "VILLA_ALREADY_MEW_FOLLOW_UP",
    "VILLA_NOT_MEW_FOLLOW_UP",
  ],
  [
    "MEW inspection",
    "mew-inspection",
    "mewInspection",
    "villa.mew_inspection",
    "VILLA_ALREADY_MEW_INSPECTION",
    "VILLA_NOT_MEW_INSPECTION",
  ],
  [
    "MEW inspection passed",
    "mew-inspection-passed",
    "mewInspectionPassed",
    "villa.mew_inspection_passed",
    "VILLA_ALREADY_MEW_INSPECTION_PASSED",
    "VILLA_NOT_MEW_INSPECTION_PASSED",
  ],
] as const)("the %s mark", (_name, path, field, action, alreadyCode, notCode) => {
  const url = () => `/villas/${villa.id}/${path}`;
  beforeEach(() => {
    Object.assign(live(), submitted);
  });

  it("is put on by a person, with who and when, and taken off again, each audited", async () => {
    const on = await send("post", url());

    expect(on.status).toBe(200);
    expect(on.body.data[field]).toEqual({ at: expect.any(String), by: { id: admin.id, name: "Root Admin" } });
    expect(on.headers["etag"]).toBe('"2"');

    const off = await send("delete", url());

    expect(off.status).toBe(200);
    expect(off.body.data[field]).toBeNull();
    expect(auditRows().map((row) => row["action"])).toEqual([action, `${action}_undo`]);
    expect(auditRows()[0]).toMatchObject({
      before: { [`${field}At`]: null },
      after: { [`${field}ById`]: admin.id },
    });
  });

  it("refuses to put it on twice, or to take it off when it is not there, with 409", async () => {
    expect((await send("delete", url())).body.code).toBe(notCode);
    await send("post", url());
    const again = await send("post", url());

    expect(again.status).toBe(409);
    expect(again.body.code).toBe(alreadyCode);
  });

  it("refuses a stale version with 409 VERSION_CONFLICT", async () => {
    const res = await send("post", url(), { ifMatch: '"7"' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(live()[`${field}At`]).toBeNull();
  });

  it("needs villas:inspection", async () => {
    const reader = employee("reader@example.test", "villas:read");

    expect((await send("post", url(), { user: reader })).status).toBe(403);
  });

  it("filters the list by it", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    await send("post", url());

    const marked = await send("get", `/villas?${field}=true`);
    const unmarked = await send("get", `/villas?${field}=false`);

    expect(marked.body.data.map((v: { id: string }) => v.id)).toEqual([villa.id]);
    expect(unmarked.body.data.map((v: { id: string }) => v.id)).toEqual([other.id]);
  });
});

it("moves a villa that passed off the MEW inspection list and onto the passed list, and back when it is taken back", async () => {
  const other = addVilla({ villaNumber: "P-002", ...submitted });
  Object.assign(live(), submitted);
  await send("post", `/villas/${villa.id}/mew-inspection`);
  await send("post", `/villas/${other.id}/mew-inspection`);

  await send("post", `/villas/${villa.id}/mew-inspection-passed`);
  // The MEW inspection page asks for the villas on the list that have not passed; the passed page for the passed ones.
  const waiting = await send("get", "/villas?mewInspection=true&mewInspectionPassed=false");
  const passed = await send("get", "/villas?mewInspectionPassed=true");

  expect(waiting.body.data.map((v: { id: string }) => v.id)).toEqual([other.id]);
  expect(passed.body.data.map((v: { id: string }) => v.id)).toEqual([villa.id]);
  expect(passed.body.data[0].mewInspectionPassed).toEqual({
    at: expect.any(String),
    by: { id: admin.id, name: "Root Admin" },
  });

  await send("delete", `/villas/${villa.id}/mew-inspection-passed`);
  const back = await send("get", "/villas?mewInspection=true&mewInspectionPassed=false");
  expect(back.body.data.map((v: { id: string }) => v.id).sort()).toEqual([villa.id, other.id].sort());
});

it("keeps the two marks apart: a villa can be on both lists, and taking one off leaves the other", async () => {
  Object.assign(live(), submitted);
  await send("post", `/villas/${villa.id}/mew-follow-up`);
  await send("post", `/villas/${villa.id}/mew-inspection`);
  await send("delete", `/villas/${villa.id}/mew-follow-up`);

  const res = await send("get", `/villas/${villa.id}`);

  expect(res.body.data.mewFollowUp).toBeNull();
  expect(res.body.data.mewInspection).not.toBeNull();
});

describe("adding a villa for MEW inspection before both MEW files are approved", () => {
  const url = () => `/villas/${villa.id}/mew-inspection`;

  it.each([
    ["neither state is submitted", {}],
    ["both states are RUNNING", { mewAcState: "RUNNING", mewElecState: "RUNNING" }],
    ["the AC state is NOT_SUBMITTED", { mewElecState: "APPROVED" }],
    ["the AC state is RUNNING", { mewAcState: "RUNNING", mewElecState: "APPROVED" }],
    ["the electricity state is NOT_SUBMITTED", { mewAcState: "APPROVED" }],
    ["the electricity state is RUNNING", { mewAcState: "APPROVED", mewElecState: "RUNNING" }],
  ] as const)(
    "refuses it with 409 VILLA_MEW_NOT_APPROVED when %s, and writes nothing",
    async (_case, states) => {
      Object.assign(live(), states);

      const res = await send("post", url());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VILLA_MEW_NOT_APPROVED");
      expect(live().mewInspectionAt).toBeNull();
      expect(live().version).toBe(1);
      expect(auditRows()).toEqual([]);
    },
  );

  it("says why in the request's language", async () => {
    const en = await send("post", url());
    const ar = await send("post", url(), { language: "ar" });

    expect(en.body.message).toMatch(/must be Approved/);
    expect(ar.body.message).toMatch(/التكييف والكهرباء/);
  });

  it("allows it once both are APPROVED, and the MEW follow-up mark needs neither", async () => {
    expect((await send("post", `/villas/${villa.id}/mew-follow-up`)).status).toBe(200);
    await send("patch", `/villas/${villa.id}/mew-states`, {
      body: { mewAcState: "APPROVED", mewElecState: "APPROVED" },
    });

    const res = await send("post", url());

    expect(res.status).toBe(200);
    expect(res.body.data.mewInspection).not.toBeNull();
  });
});

describe("PATCH /villas/:id/mew-states", () => {
  const url = () => `/villas/${villa.id}/mew-states`;

  it("starts NOT_SUBMITTED for both, and sets either or both", async () => {
    expect((await send("get", `/villas/${villa.id}`)).body.data).toMatchObject({
      mewAcState: "NOT_SUBMITTED",
      mewElecState: "NOT_SUBMITTED",
    });

    const ac = await send("patch", url(), { body: { mewAcState: "RUNNING" } });
    const both = await send("patch", url(), { body: { mewAcState: "APPROVED", mewElecState: "RUNNING" } });

    expect(ac.status).toBe(200);
    expect(ac.body.data).toMatchObject({ mewAcState: "RUNNING", mewElecState: "NOT_SUBMITTED", version: 2 });
    expect(both.body.data).toMatchObject({ mewAcState: "APPROVED", mewElecState: "RUNNING", version: 3 });
    expect(auditRows().at(-1)).toMatchObject({
      action: "villa.mew_states",
      before: { mewAcState: "RUNNING", mewElecState: "NOT_SUBMITTED" },
      after: { mewAcState: "APPROVED", mewElecState: "RUNNING" },
    });
  });

  it("sets the MEW inspection day, clears it with null, and refuses a value that is not a day", async () => {
    const set = await send("patch", url(), { body: { mewInspectionDate: "2026-12-01" } });

    expect(set.status).toBe(200);
    expect(set.body.data.mewInspectionDate).toBe("2026-12-01");
    expect(auditRows().at(-1)).toMatchObject({
      action: "villa.mew_states",
      before: { mewInspectionDate: null },
      after: { mewInspectionDate: "2026-12-01" },
    });

    const cleared = await send("patch", url(), { body: { mewInspectionDate: null } });
    expect(cleared.body.data.mewInspectionDate).toBeNull();
    expect((await send("patch", url(), { body: { mewInspectionDate: "next week" } })).status).toBe(400);
  });

  it("writes nothing when the states are already as asked", async () => {
    const res = await send("patch", url(), { body: { mewAcState: "NOT_SUBMITTED" } });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a value outside the list, an empty body and an unknown field with 400", async () => {
    for (const body of [{ mewAcState: "DONE" }, {}, { mewAcState: "RUNNING", note: "x" }]) {
      const res = await send("patch", url(), { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(live().mewAcState).toBe("NOT_SUBMITTED");
  });

  it("refuses a stale version with 409, and needs villas:inspection", async () => {
    const stale = await send("patch", url(), { body: { mewAcState: "RUNNING" }, ifMatch: '"5"' });
    const reader = employee("reader@example.test", "villas:read");

    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect((await send("patch", url(), { body: { mewAcState: "RUNNING" }, user: reader })).status).toBe(403);
  });
});
