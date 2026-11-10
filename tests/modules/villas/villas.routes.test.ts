import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addArea, areaTables } from "../areas/in-memory-areas.repository.js";
import { addVilla, areaNamed, villaTables } from "./in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("./in-memory-villas.repository.js")).InMemoryVillasRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const nid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let admin: User;
let eng1: ReturnType<typeof addEngineer>;
let eng2: ReturnType<typeof addEngineer>;
let conA: ReturnType<typeof addContractor>;
let conB: ReturnType<typeof addContractor>;
let conC: ReturnType<typeof addContractor>;
let elec1: ReturnType<typeof addElectricalEngineer>;
let elec2: ReturnType<typeof addElectricalEngineer>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  electricalTables.reset();
  contractorTables.reset();
  villaTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  eng1 = addEngineer({ name: "Mona Hassan", phone: "0100 123 4567" });
  eng2 = addEngineer({ name: "Omar Said", phone: "0101 765 4321" });
  conA = addContractor({ name: "Nile Builders", phone: "0102 000 0001" });
  conB = addContractor({ name: "Delta Works", phone: "0102 000 0002" });
  conC = addContractor({ name: "Giza Co", phone: "0102 000 0003" });
  elec1 = addElectricalEngineer({ name: "Hany Wagdy", phone: "0103 111 2222" });
  elec2 = addElectricalEngineer({ name: "Tarek Nabil", phone: "0103 333 4444" });
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
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1/villas${path}`);

const asAdmin = async (verb: Verb, path: string, language = "en", body?: unknown) => {
  const req = call(verb, path)
    .set(await as(admin))
    .set("Accept-Language", language);
  return body === undefined ? req : req.send(body as object);
};

const numbers = (res: request.Response): string[] =>
  res.body.data.map((item: { villaNumber: string }) => item.villaNumber);
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
// An id that is well formed but belongs to no area: for the bodies that must fail validation, or the lookup.
const AREA_ID = "44444444-4444-4444-8444-444444444444";

const stored = (number: string) => villaTables.villas.find((p) => p.villaNumber === number);

// Six villas with known dates, engineers and contractors; the fourth has none. Ids ascend with the number,
// so rows that tie on the sort column come back in villa-number order.
function seed() {
  const mk = (n: number, o: Parameters<typeof addVilla>[0]) =>
    addVilla({
      id: nid(n),
      villaNumber: `P-00${n}`,
      plot: String(9 + n),
      createdAt: day(`2026-01-0${n}`),
      ...o,
    });
  const p1 = mk(1, {
    area: "New Cairo",
    block: "B1",
    ownerName: "Khaled Mansour",
    civilEngineerId: eng1.id,
    electricalEngineerId: elec1.id,
    contractorId: conA.id,
    startDate: day("2026-01-05"),
    targetDate: day("2026-03-01"),
    budgetMinor: 125050,
    currency: "EGP",
  });
  const p2 = mk(2, {
    area: "New Cairo",
    block: "B2",
    civilEngineerId: eng1.id,
    contractorId: conA.id,
    targetDate: day("2026-02-01"),
  });
  const p3 = mk(3, {
    area: "Sheikh Zayed",
    block: "B1",
    ownerName: "Samir Fahmy",
    civilEngineerId: eng2.id,
    electricalEngineerId: elec2.id,
    contractorId: conB.id,
    startDate: day("2026-01-03"),
  });
  const p4 = mk(4, {
    area: "Sheikh Zayed",
    block: "B3",
    civilEngineerId: eng2.id,
    startDate: day("2026-01-04"),
    targetDate: day("2026-02-15"),
  });
  const p5 = mk(5, { area: "6 October", block: "B2", civilEngineerId: eng1.id, contractorId: conC.id });
  const p6 = mk(6, {
    area: "6 October",
    block: "B1",
    electricalEngineerId: elec1.id,
    civilEngineerId: eng2.id,
    contractorId: conA.id,
    startDate: day("2026-01-02"),
    targetDate: day("2026-01-20"),
  });
  return { p1, p2, p3, p4, p5, p6 };
}

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "villas:read"],
    ["get", "/options", "villas:read"],
    ["get", "/filters", "villas:read"],
    ["get", `/${MISSING_ID}`, "villas:detail"],
    ["post", "", "villas:create"],
    ["patch", `/${MISSING_ID}`, "villas:update"],
    ["delete", `/${MISSING_ID}`, "villas:delete"],
    ["post", `/${MISSING_ID}/mew-follow-up`, "villas:inspection"],
    ["delete", `/${MISSING_ID}/mew-follow-up`, "villas:inspection"],
    ["post", `/${MISSING_ID}/mew-inspection`, "villas:inspection"],
    ["delete", `/${MISSING_ID}/mew-inspection`, "villas:inspection"],
    ["post", `/${MISSING_ID}/mew-inspection-passed`, "villas:inspection"],
    ["delete", `/${MISSING_ID}/mew-inspection-passed`, "villas:inspection"],
    ["patch", `/${MISSING_ID}/mew-states`, "villas:inspection"],
  ];
  const allCodes = [
    "villas:read",
    "villas:detail",
    "villas:create",
    "villas:update",
    "villas:delete",
    "villas:export",
    "villas:progress",
    "villas:inspection",
  ];

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path).send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it.each(endpoints)(
    "%s %s answers 403 to an employee with no permissions, in Arabic",
    async (verb, path) => {
      const res = await call(verb, path)
        .set(await as(employee("e@example.test")))
        .set("Accept-Language", "ar")
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)(
    "%s %s is not opened by any of the other villas permissions",
    async (verb, path, needed) => {
      const others = allCodes
        .filter((code) => code !== needed)
        .concat("civil-engineers:read", "contractors:read", "contractors:summary");

      const res = await call(verb, path)
        .set(await as(employee("e@example.test", ...others)))
        .send({});

      expect(res.status).toBe(403);
    },
  );

  it.each(endpoints)("%s %s lets through the holder of %s", async (verb, path, needed) => {
    const res = await call(verb, path)
      .set(await as(employee("e@example.test", needed)))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it.each(endpoints)("%s %s lets the ADMIN through with no granted permissions", async (verb, path) => {
    const res = await call(verb, path)
      .set(await as(admin))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it("villas:read does not open a single villa, and villas:detail does not open the list", async () => {
    const { p1 } = seed();
    const reader = await as(employee("r@example.test", "villas:read"));
    const detailer = await as(employee("d@example.test", "villas:detail"));

    expect((await call("get", `/${p1.id}`).set(reader)).status).toBe(403);
    expect((await call("get", `/${p1.id}`).set(detailer)).status).toBe(200);
    expect((await call("get", "").set(detailer)).status).toBe(403);
    expect((await call("get", "").set(reader)).status).toBe(200);
  });

  it("checks access before validating", async () => {
    const res = await call("post", "")
      .set(await as(employee("e@example.test")))
      .send({ nonsense: true });

    expect(res.status).toBe(403);
  });
});

describe("GET /villas", () => {
  beforeEach(() => {
    seed();
  });

  it("lists in location order by default, with the shared pagination meta and the documented item shape", async () => {
    const res = await asAdmin("get", "");

    expect(res.status).toBe(200);
    expect(numbers(res)).toEqual(["P-006", "P-005", "P-001", "P-002", "P-003", "P-004"]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 6, totalPages: 1 });
    expect(Object.keys(res.body.data[2]).sort()).toEqual(
      [
        "area",
        "areaId",
        "block",
        "budgetMinor",
        "civilEngineer",
        "contractor",
        "createdAt",
        "currency",
        "electricalEngineer",
        "id",
        "location",
        "mewAcState",
        "mewElecState",
        "mewFollowUp",
        "mewInspection",
        "mewInspectionDate",
        "mewInspectionPassed",
        "ownerName",
        "plot",
        "progress",
        "startDate",
        "targetDate",
        "updatedAt",
        "version",
        "villaNumber",
        "villaType",
      ].sort(),
    );
    expect(res.body.data[2]).toMatchObject({
      villaNumber: "P-001",
      ownerName: "Khaled Mansour",
      area: "New Cairo",
      block: "B1",
      plot: "10",
      location: "New Cairo . B1 . 10",
      civilEngineer: { id: eng1.id, name: "Mona Hassan" },
      electricalEngineer: { id: elec1.id, name: "Hany Wagdy" },
      contractor: { id: conA.id, name: "Nile Builders" },
      startDate: "2026-01-05",
      targetDate: "2026-03-01",
      budgetMinor: 125050,
      currency: "EGP",
    });
  });

  it("shows no owner, electrical engineer or budget as null", async () => {
    const res = await asAdmin("get", "?sort=villaNumber");

    expect(res.body.data[1]).toMatchObject({
      ownerName: null,
      electricalEngineer: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("shows the villa's one contractor by name, null when it has none, and null dates as null", async () => {
    const res = await asAdmin("get", "?sort=villaNumber");

    expect(res.body.data[0].contractor).toEqual({ id: conA.id, name: "Nile Builders" });
    expect(res.body.data[2].contractor).toEqual({ id: conB.id, name: "Delta Works" });
    expect(res.body.data[3].contractor).toBeNull();
    expect(res.body.data[1]).toMatchObject({
      startDate: null,
      targetDate: "2026-02-01",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/phone/);
  });

  it("no longer carries the removed status, flags or contractor list", async () => {
    const res = await asAdmin("get", "");

    for (const key of ["status", "checklistCompleted", "materialRequested", "contractors"]) {
      expect(res.body.data[0]).not.toHaveProperty(key);
    }
  });

  it("pages with limit and page", async () => {
    const second = await asAdmin("get", "?limit=2&page=2&sort=villaNumber");

    expect(numbers(second)).toEqual(["P-003", "P-004"]);
    expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 6, totalPages: 3 });
    expect(numbers(await asAdmin("get", "?limit=2&page=4"))).toEqual([]);
  });

  it("accepts a limit of 1000 and rejects 1001 with 400 instead of clamping it, in Arabic", async () => {
    expect((await asAdmin("get", "?limit=1000")).status).toBe(200);

    const res = await asAdmin("get", "?limit=1001", "ar");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(res.body.details[0].path).toBe("limit");
  });

  it.each(["0", "-1", "abc", "1.5", ""])("rejects limit=%j with 400", async (value) => {
    expect((await asAdmin("get", `?limit=${value}`, "ar")).status).toBe(400);
  });

  describe("filters", () => {
    const filtered = async (query: string) => numbers(await asAdmin("get", `?sort=villaNumber&${query}`));

    it("by areaId: exactly that area, however many areas share a name", async () => {
      const [first, second] = [stored("P-001"), stored("P-003")];
      expect(await filtered(`areaId=${first?.areaId}`)).toEqual(["P-001", "P-002"]);
      expect(await filtered(`areaId=${second?.areaId}`)).toEqual(["P-003", "P-004"]);
      expect(await filtered(`areaId=${MISSING_ID}`)).toEqual([]);
    });

    it("by area name covers every area of that name, in any city", async () => {
      addVilla({ villaNumber: "P-007", areaId: addArea({ name: "New Cairo", city: "Elsewhere" }).id });

      expect(await filtered("area=new cairo")).toEqual(["P-001", "P-002", "P-007"]);
    });

    it("by area, block and plot: exact, ignoring case", async () => {
      expect(await filtered("area=new cairo")).toEqual(["P-001", "P-002"]);
      expect(await filtered("area=NEW%20CAIRO")).toEqual(["P-001", "P-002"]);
      expect(await filtered("area=new")).toEqual([]);
      expect(await filtered("block=b1")).toEqual(["P-001", "P-003", "P-006"]);
      expect(await filtered("plot=13")).toEqual(["P-004"]);
      expect(await filtered("plot=1")).toEqual([]);
    });

    it("by civil engineer and by contractor", async () => {
      expect(await filtered(`civilEngineerId=${eng1.id}`)).toEqual(["P-001", "P-002", "P-005"]);
      expect(await filtered(`civilEngineerId=${eng2.id}`)).toEqual(["P-003", "P-004", "P-006"]);
      expect(await filtered(`contractorId=${conA.id}`)).toEqual(["P-001", "P-002", "P-006"]);
      expect(await filtered(`contractorId=${conB.id}`)).toEqual(["P-003"]);
      expect(await filtered(`contractorId=${conC.id}`)).toEqual(["P-005"]);
      expect(await filtered(`contractorId=${randomUUID()}`)).toEqual([]);
    });

    it("by the electrical engineer", async () => {
      expect(await filtered(`electricalEngineerId=${elec1.id}`)).toEqual(["P-001", "P-006"]);
      expect(await filtered(`electricalEngineerId=${elec2.id}`)).toEqual(["P-003"]);
      expect(await filtered(`electricalEngineerId=${randomUUID()}`)).toEqual([]);
    });

    it("by the start date range: calendar days, ends included, no date never matches", async () => {
      expect(await filtered("startFrom=2026-01-03&startTo=2026-01-04")).toEqual(["P-003", "P-004"]);
      expect(await filtered("startFrom=2026-01-05")).toEqual(["P-001"]);
      expect(await filtered("startTo=2026-01-02")).toEqual(["P-006"]);
      expect(await filtered("startFrom=2026-01-04&startTo=2026-01-04")).toEqual(["P-004"]);
    });

    it("by the target date range", async () => {
      expect(await filtered("targetFrom=2026-02-01&targetTo=2026-02-15")).toEqual(["P-002", "P-004"]);
      expect(await filtered("targetFrom=2026-03-01")).toEqual(["P-001"]);
      expect(await filtered("targetTo=2026-01-20")).toEqual(["P-006"]);
    });

    it("in combination, all ANDed", async () => {
      expect(await filtered(`contractorId=${conA.id}&area=new%20cairo`)).toEqual(["P-001", "P-002"]);
      expect(await filtered(`civilEngineerId=${eng2.id}&contractorId=${conA.id}`)).toEqual(["P-006"]);
      expect(await filtered(`civilEngineerId=${eng1.id}&search=khaled&targetFrom=2026-03-01`)).toEqual([
        "P-001",
      ]);
      expect(await filtered(`electricalEngineerId=${elec1.id}&contractorId=${conA.id}`)).toEqual([
        "P-001",
        "P-006",
      ]);
    });

    it("ignores the filters that went with the removed fields", async () => {
      expect(await filtered("status=CLOSED&checklistCompleted=true&materialRequested=true")).toHaveLength(6);
    });

    it.each([
      ["civilEngineerId=nope", "civilEngineerId"],
      ["electricalEngineerId=nope", "electricalEngineerId"],
      ["contractorId=nope", "contractorId"],
      ["startFrom=2026-02-30", "startFrom"],
      ["startFrom=2026-01-03T00:00:00.000Z", "startFrom"],
      ["targetTo=yesterday", "targetTo"],
      ["area=", "area"],
      ["plot=", "plot"],
      [`block=${"x".repeat(51)}`, "block"],
    ])("rejects %s with 400 on the right field", async (query, field) => {
      const res = await asAdmin("get", `?${query}`, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(field);
    });

    it("rejects a range that ends before it starts, translated, on the 'to' field", async () => {
      const started = await asAdmin("get", "?startFrom=2026-02-01&startTo=2026-01-31", "ar");
      const targeted = await asAdmin("get", "?targetFrom=2026-02-01&targetTo=2026-01-31", "ar");

      expect(started.body.details).toEqual([
        { path: "startTo", message: "يجب ألا يكون تاريخ النهاية قبل تاريخ البداية" },
      ]);
      expect(targeted.body.details).toEqual([
        { path: "targetTo", message: "يجب ألا يكون تاريخ النهاية قبل تاريخ البداية" },
      ]);
    });
  });

  describe("search", () => {
    const found = async (term: string) =>
      numbers(await asAdmin("get", `?sort=villaNumber&search=${encodeURIComponent(term)}`));

    it("matches the villa number, ignoring case and surrounding spaces", async () => {
      expect(await found("p-003")).toEqual(["P-003"]);
      expect(await found("P-00")).toHaveLength(6);
      expect(await found("  p-005  ")).toEqual(["P-005"]);
    });

    it("matches the owner name", async () => {
      expect(await found("khaled")).toEqual(["P-001"]);
      expect(await found("FAHMY")).toEqual(["P-003"]);
    });

    it("matches the civil engineer's name", async () => {
      expect(await found("mona")).toEqual(["P-001", "P-002", "P-005"]);
      expect(await found("SAID")).toEqual(["P-003", "P-004", "P-006"]);
    });

    it("matches the electrical engineer's name", async () => {
      expect(await found("hany")).toEqual(["P-001", "P-006"]);
      expect(await found("nabil")).toEqual(["P-003"]);
    });

    it("looks nowhere else: not the area, block, plot or contractor, which are filters", async () => {
      expect(await found("cairo")).toEqual([]);
      expect(await found("october")).toEqual([]);
      expect(await found("b3")).toEqual([]);
      expect(await found("14")).toEqual([]);
      expect(await found("nile")).toEqual([]);
      expect(await found("giza")).toEqual([]);
    });

    it("finds nothing for text that matches nothing, and combines with the filters", async () => {
      const none = await asAdmin("get", "?search=zzz");
      expect(none.body.data).toEqual([]);
      expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
      expect(await found("mona omar")).toEqual([]);
      expect(
        numbers(await asAdmin("get", `?sort=villaNumber&search=hany&civilEngineerId=${eng2.id}`)),
      ).toEqual(["P-006"]);
    });

    it("rejects a search longer than 100 characters", async () => {
      expect((await asAdmin("get", `?search=${"x".repeat(101)}`, "ar")).status).toBe(400);
      expect((await asAdmin("get", `?search=${"x".repeat(100)}`)).status).toBe(200);
    });
  });

  describe("sort", () => {
    const order = async (sort: string) =>
      (await asAdmin("get", `?sort=${sort}`)).body.data
        .map((p: { villaNumber: string }) => p.villaNumber.slice(-1))
        .join("");

    it.each([
      ["villaNumber", "123456"],
      ["villaNumber:desc", "654321"],
      ["location", "651234"],
      ["location:asc", "651234"],
      ["location:desc", "432156"],
      ["createdAt", "123456"],
      ["createdAt:desc", "654321"],
    ])("sorts by %s", async (sort, expected) => {
      expect(await order(sort)).toBe(expected);
    });

    it("puts villas without a target date last, whichever way it is sorted", async () => {
      expect(await order("targetDate")).toBe("624135");
      expect(await order("targetDate:asc")).toBe("624135");
      expect(await order("targetDate:desc")).toBe("142635");
    });

    it("orders locations by area, then block, then plot, the way a person counts", async () => {
      addVilla({ villaNumber: "L-1", area: "New Cairo", block: "B1", plot: "100" });
      addVilla({ villaNumber: "L-2", area: "New Cairo", block: "B1", plot: "9" });
      addVilla({ villaNumber: "L-3", area: "New Cairo", block: "B10", plot: "1" });
      addVilla({ villaNumber: "L-4", area: "New Cairo", block: "B2", plot: "1" });

      const res = await asAdmin("get", "?limit=50");
      const newCairo = res.body.data
        .filter((item: { area: string }) => item.area === "New Cairo")
        .map((item: { location: string }) => item.location);

      expect(newCairo).toEqual([
        "New Cairo . B1 . 9",
        "New Cairo . B1 . 10",
        "New Cairo . B1 . 100",
        "New Cairo . B2 . 1",
        "New Cairo . B2 . 11",
        "New Cairo . B10 . 1",
      ]);
    });

    it("sorts the villa number the same way (P-2 before P-10)", async () => {
      addVilla({ villaNumber: "V-10", area: "Other", plot: "1" });
      addVilla({ villaNumber: "V-2", area: "Other", plot: "2" });

      const res = await asAdmin("get", "?sort=villaNumber&search=v-");

      expect(numbers(res)).toEqual(["V-2", "V-10"]);
    });

    it("breaks ties by id, so repeated pages are identical", async () => {
      addVilla({
        id: nid(90),
        villaNumber: "T-B",
        area: "Tie",
        block: "B1",
        plot: "1",
        createdAt: day("2026-02-01"),
      });
      addVilla({
        id: nid(89),
        villaNumber: "T-A",
        area: "Tie",
        block: "B1",
        plot: "2",
        createdAt: day("2026-02-01"),
      });
      const first = await asAdmin("get", "?sort=createdAt:desc&limit=1&page=1");
      const second = await asAdmin("get", "?sort=createdAt:desc&limit=1&page=2");

      expect([...numbers(first), ...numbers(second)]).toEqual(["T-A", "T-B"]);
    });

    it.each([
      "civilEngineer",
      "contractor",
      "status",
      "progress:up",
      "area",
      "block",
      "plot",
      "startDate",
      "id:asc",
      "plot:up",
      "createdAt:asc:x",
      ":asc",
    ])("rejects sort=%j with 400 and a translated message", async (sort) => {
      const res = await asAdmin("get", `?sort=${encodeURIComponent(sort)}`, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("sort");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    });
  });
});

describe("GET /villas/options and /villas/filters", () => {
  it("are not mistaken for ids, and are empty when there are no villas", async () => {
    const options = await asAdmin("get", "/options");
    const filters = await asAdmin("get", "/filters");

    expect(options.status).toBe(200);
    expect(options.body.data).toEqual([]);
    expect(filters.status).toBe(200);
    expect(filters.body.data).toEqual({ areas: [], blocks: [], civilEngineers: [], electricalEngineers: [] });
  });

  it("options: only id and villaNumber, sorted by villa number, no meta", async () => {
    const { p1, p2 } = seed();

    const res = await asAdmin("get", "/options");

    expect(res.body.data.slice(0, 2)).toEqual([
      { id: p1.id, villaNumber: "P-001" },
      { id: p2.id, villaNumber: "P-002" },
    ]);
    expect(res.body).not.toHaveProperty("meta");
    expect(JSON.stringify(res.body)).not.toMatch(/must not leak/);
  });

  it("options: returns at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++)
      addVilla({ villaNumber: `BULK-${String(i).padStart(4, "0")}`, plot: `b${i}` });

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toHaveLength(1000);
  });

  it("filters: distinct areas and blocks, sorted", async () => {
    seed();

    const res = await asAdmin("get", "/filters");

    expect(res.body.data).toMatchObject({
      areas: ["6 October", "New Cairo", "Sheikh Zayed"],
      blocks: ["B1", "B2", "B3"],
    });
    // The engineers that have villas, each once, by name.
    type Party = { id: string; name: string };
    const { civilEngineers, electricalEngineers } = res.body.data as {
      civilEngineers: Party[];
      electricalEngineers: Party[];
    };
    expect(civilEngineers.length).toBeGreaterThan(0);
    expect(civilEngineers.map((e) => e.name)).toEqual([...civilEngineers.map((e) => e.name)].sort());
    expect(new Set(civilEngineers.map((e) => e.id)).size).toBe(civilEngineers.length);
    expect(Array.isArray(electricalEngineers)).toBe(true);
  });

  it("filters the list by villa type", async () => {
    const { p1 } = seed();
    p1.villaType = "CONVENTIONAL";

    const res = await asAdmin("get", "?villaType=CONVENTIONAL");

    expect(res.status).toBe(200);
    expect(res.body.data.map((v: { id: string }) => v.id)).toEqual([p1.id]);
    expect((await asAdmin("get", "?villaType=WRONG")).status).toBe(400);
  });
});

describe("GET /villas/:id", () => {
  it("returns the full record, with the contractor's and engineers' phone", async () => {
    const { p1 } = seed();
    store.addUser({ name: "Creator", email: "c@example.test", passwordHash: "x" });
    p1.createdById = store.users.at(-1)!.id;

    const res = await asAdmin("get", `/${p1.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: p1.id,
      villaNumber: "P-001",
      ownerName: "Khaled Mansour",
      area: "New Cairo",
      location: "New Cairo . B1 . 10",
      civilEngineer: { id: eng1.id, name: "Mona Hassan", phone: "0100 123 4567" },
      electricalEngineer: { id: elec1.id, name: "Hany Wagdy", phone: "0103 111 2222" },
      contractor: { id: conA.id, name: "Nile Builders", phone: "0102 000 0001" },
      startDate: "2026-01-05",
      targetDate: "2026-03-01",
      budgetMinor: 125050,
      currency: "EGP",
      createdBy: { id: p1.createdById, name: "Creator" },
    });
    for (const key of ["status", "activities", "contractors", "checklistCompleted", "files"]) {
      expect(res.body.data).not.toHaveProperty(key);
    }
  });

  it("shows a villa with no contractor as contractor null", async () => {
    const { p4 } = seed();

    const res = await asAdmin("get", `/${p4.id}`);

    expect(res.body.data.contractor).toBeNull();
  });

  it("answers 404 VILLA_NOT_FOUND in Arabic, and 400 for a malformed id", async () => {
    const missing = await asAdmin("get", `/${MISSING_ID}`, "ar");
    const malformed = await asAdmin("get", "/not-a-uuid", "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("POST /villas", () => {
  const body = () => ({
    villaNumber: "NEW-1",
    areaId: areaNamed("Zayed"),
    block: "B9",
    plot: "99",
    civilEngineerId: eng1.id,
  });

  it("creates the villa, owned by the caller, with no contractor and no dates by default", async () => {
    const res = await asAdmin("post", "", "en", body());

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      villaNumber: "NEW-1",
      area: "Zayed",
      block: "B9",
      plot: "99",
      location: "Zayed . B9 . 99",
      civilEngineer: { id: eng1.id, name: "Mona Hassan" },
      ownerName: null,
      electricalEngineer: null,
      contractor: null,
      startDate: null,
      targetDate: null,
      budgetMinor: null,
      currency: null,
      version: 1,
    });
    expect(stored("NEW-1")?.createdById).toBe(admin.id);
  });

  it("stores the villa type, null when it is not sent", async () => {
    const res = await asAdmin("post", "", "en", { ...body(), villaType: "ACICO_SYSTEM" });

    expect(res.status).toBe(201);
    expect(res.body.data.villaType).toBe("ACICO_SYSTEM");
    expect(stored("NEW-1")?.villaType).toBe("ACICO_SYSTEM");

    const plain = await asAdmin("post", "", "en", { ...body(), villaNumber: "NEW-2", plot: "100" });
    expect(plain.status).toBe(201);
    expect(plain.body.data.villaType).toBeNull();
  });

  it("refuses a villa type that is not one of the two", async () => {
    const res = await asAdmin("post", "", "en", { ...body(), villaType: "MODERN" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stored("NEW-1")).toBeUndefined();
  });

  it("changes the villa type on update", async () => {
    const created = await asAdmin("post", "", "en", { ...body(), villaType: "ACICO_SYSTEM" });
    const res = await asAdmin("patch", `/${created.body.data.id}`, "en", { villaType: "CONVENTIONAL" });

    expect(res.status).toBe(200);
    expect(res.body.data.villaType).toBe("CONVENTIONAL");
  });

  it("sets the contractor and takes the optional dates as calendar days", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body(),
      contractorId: conA.id,
      startDate: "2026-01-05",
      targetDate: "2026-03-01",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      contractor: { id: conA.id, name: "Nile Builders" },
      startDate: "2026-01-05",
      targetDate: "2026-03-01",
    });
    expect(stored("NEW-1")?.contractorId).toBe(conA.id);
    expect(stored("NEW-1")?.startDate).toEqual(day("2026-01-05"));
  });

  it("sets the owner, the electrical engineer and the budget", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body(),
      ownerName: "  Khaled Mansour ",
      electricalEngineerId: elec1.id,
      budgetMinor: 125050,
      currency: "usd",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ownerName: "Khaled Mansour",
      electricalEngineer: { id: elec1.id, name: "Hany Wagdy" },
      budgetMinor: 125050,
      currency: "USD",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/0103/);
    expect(stored("NEW-1")).toMatchObject({ electricalEngineerId: elec1.id, budgetMinor: 125050 });
  });

  it("says in both languages that a budget is a whole number of minor units, naming fils first", async () => {
    const en = await asAdmin("post", "", "en", { ...body(), budgetMinor: 1.5 });
    const ar = await asAdmin("post", "", "ar", { ...body(), budgetMinor: 1.5 });

    expect(en.status).toBe(400);
    expect(en.body.details).toEqual([
      {
        path: "budgetMinor",
        message: "The budget must be a whole number of minor units (fils, piastres, cents), 0 or more",
      },
    ]);
    expect(ar.body.details).toEqual([
      {
        path: "budgetMinor",
        message: "يجب أن تكون الميزانية عددًا صحيحًا من الوحدات الصغرى (فلس، قرش، سنت)، صفرًا أو أكثر",
      },
    ]);
  });

  it("gives a budget without a currency KWD, and accepts a budget of 0", async () => {
    const res = await asAdmin("post", "", "en", { ...body(), budgetMinor: 0 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ budgetMinor: 0, currency: "KWD" });
  });

  it.each(["EGP", "KWD", "JPY"])("keeps the currency %s when it is sent with the budget", async (code) => {
    const res = await asAdmin("post", "", "en", { ...body(), budgetMinor: 1234, currency: code });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ budgetMinor: 1234, currency: code });
    expect(stored("NEW-1")).toMatchObject({ budgetMinor: 1234, currency: code });
  });

  it("takes null for the owner, the electrical engineer and the budget", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body(),
      ownerName: null,
      electricalEngineerId: null,
      budgetMinor: null,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ownerName: null,
      electricalEngineer: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("trims the identifying fields, and accepts null for the contractor and the dates", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body(),
      villaNumber: "  NEW-1  ",
      contractorId: null,
      startDate: null,
      targetDate: null,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.villaNumber).toBe("NEW-1");
    expect(res.body.data.contractor).toBeNull();
  });

  it("answers with the list shape, never the phone numbers of the engineer or contractor", async () => {
    const res = await asAdmin("post", "", "en", { ...body(), contractorId: conA.id });

    expect(JSON.stringify(res.body)).not.toMatch(/phone|0100 123 4567|0102 000 0001/);
    expect(res.body.data).not.toHaveProperty("createdBy");
  });

  it("works for a caller with only villas:create, who holds no engineer or contractor permission", async () => {
    const res = await call("post", "")
      .set(await as(employee("creator@example.test", "villas:create")))
      .send({ ...body(), contractorId: conA.id });

    expect(res.status).toBe(201);
  });

  it("writes the audit row in the same transaction, with the full new snapshot", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body(),
      ownerName: "Khaled Mansour",
      electricalEngineerId: elec2.id,
      contractorId: conB.id,
      startDate: "2026-01-05",
      budgetMinor: 5000,
    });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "villa.create",
      entity: "Villa",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        villaNumber: "NEW-1",
        ownerName: "Khaled Mansour",
        areaId: areaNamed("Zayed"),
        block: "B9",
        plot: "99",
        civilEngineerId: eng1.id,
        electricalEngineerId: elec2.id,
        contractorId: conB.id,
        startDate: "2026-01-05",
        targetDate: null,
        budgetMinor: 5000,
        currency: "KWD",
      },
      requestId: expect.any(String),
    });
    expect(auditRows()[0]).not.toHaveProperty("before");
  });

  describe("uniqueness", () => {
    it("answers 409 VILLA_NUMBER_TAKEN for a villa number in use, in Arabic on request", async () => {
      addVilla({ villaNumber: "NEW-1", area: "Other", plot: "1" });

      const res = await asAdmin("post", "", "ar", body());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "VILLA_NUMBER_TAKEN", message: "رقم الفيلا مستخدم بالفعل" });
      expect(villaTables.villas).toHaveLength(1);
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 409 VILLA_PLOT_TAKEN for the same area, block and plot", async () => {
      addVilla({ villaNumber: "OLD-1", area: "Zayed", block: "B9", plot: "99" });

      const res = await asAdmin("post", "", "ar", body());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "VILLA_PLOT_TAKEN",
        message: "توجد فيلا بالفعل لهذه المنطقة والقطاع والقطعة",
      });
    });

    it("allows the same plot in another block or area, and the same block elsewhere", async () => {
      addVilla({ villaNumber: "OLD-1", area: "Zayed", block: "B9", plot: "99" });

      expect((await asAdmin("post", "", "en", { ...body(), villaNumber: "NEW-2", block: "B8" })).status).toBe(
        201,
      );
      expect(
        (await asAdmin("post", "", "en", { ...body(), villaNumber: "NEW-3", areaId: areaNamed("Cairo") }))
          .status,
      ).toBe(201);
    });

    it("treats a different letter case as a different value, because the database constraints do", async () => {
      addVilla({ villaNumber: "NEW-1", area: "Other", plot: "1" });

      expect((await asAdmin("post", "", "en", { ...body(), villaNumber: "new-1" })).status).toBe(201);
    });

    it("answers 409 when another request takes the number between the check and the write (race)", async () => {
      villaTables.beforeWrite = () => {
        addVilla({ villaNumber: "NEW-1", area: "Racer", plot: "1" });
      };

      const res = await asAdmin("post", "", "en", body());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VILLA_NUMBER_TAKEN");
      expect(villaTables.villas).toHaveLength(1);
    });

    it("answers 409 for the plot when another request takes it in the same gap", async () => {
      villaTables.beforeWrite = () => {
        addVilla({ villaNumber: "RACER-1", area: "Zayed", block: "B9", plot: "99" });
      };

      const res = await asAdmin("post", "", "en", body());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VILLA_PLOT_TAKEN");
    });
  });

  describe("references", () => {
    it("answers 404 AREA_NOT_FOUND for an unknown area, in Arabic on request, and creates nothing", async () => {
      const res = await asAdmin("post", "", "ar", { ...body(), areaId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "AREA_NOT_FOUND", message: "المنطقة غير موجودة" });
      expect(villaTables.villas).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 404 when the area is deleted between the check and the write (race)", async () => {
      villaTables.beforeWrite = () => {
        areaTables.areas = [];
      };

      const res = await asAdmin("post", "", "en", body());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("AREA_NOT_FOUND");
      expect(villaTables.villas).toHaveLength(0);
    });

    it("answers 404 CIVIL_ENGINEER_NOT_FOUND for an unknown engineer", async () => {
      const res = await asAdmin("post", "", "ar", { ...body(), civilEngineerId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "CIVIL_ENGINEER_NOT_FOUND",
        message: "المهندس المدني غير موجود",
      });
      expect(villaTables.villas).toHaveLength(0);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for an unknown contractor, in Arabic on request", async () => {
      const res = await asAdmin("post", "", "ar", { ...body(), contractorId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
      expect(villaTables.villas).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 404 when the engineer is deleted between the check and the write (race)", async () => {
      villaTables.beforeWrite = () => {
        engineerTables.engineers = engineerTables.engineers.filter((e) => e.id !== eng1.id);
      };

      const res = await asAdmin("post", "", "en", body());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CIVIL_ENGINEER_NOT_FOUND");
      expect(villaTables.villas).toHaveLength(0);
    });

    it("answers 404 when the contractor is deleted between the check and the write (race)", async () => {
      villaTables.beforeWrite = () => {
        contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== conA.id);
      };

      const res = await asAdmin("post", "", "en", { ...body(), contractorId: conA.id });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(villaTables.villas).toHaveLength(0);
    });
  });

  describe("the electrical engineer", () => {
    it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND for an unknown one, in Arabic, and creates nothing", async () => {
      const res = await asAdmin("post", "", "ar", { ...body(), electricalEngineerId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELECTRICAL_ENGINEER_NOT_FOUND");
      expect(villaTables.villas).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 404 when it is deleted between the check and the write (race)", async () => {
      villaTables.beforeWrite = () => {
        electricalTables.engineers = electricalTables.engineers.filter((e) => e.id !== elec1.id);
      };

      const res = await asAdmin("post", "", "en", { ...body(), electricalEngineerId: elec1.id });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELECTRICAL_ENGINEER_NOT_FOUND");
      expect(villaTables.villas).toHaveLength(0);
    });
  });

  describe("inactive parties", () => {
    it("refuses an inactive civil engineer, with a stable code and a translated message", async () => {
      const inactive = addEngineer({ name: "Retired", status: "INACTIVE" });

      const res = await asAdmin("post", "", "ar", { ...body(), civilEngineerId: inactive.id });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "CIVIL_ENGINEER_INACTIVE",
        message: "هذا المهندس المدني غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(villaTables.villas).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it("refuses an inactive electrical engineer", async () => {
      const inactive = addElectricalEngineer({ name: "Retired", status: "INACTIVE" });

      const res = await asAdmin("post", "", "ar", { ...body(), electricalEngineerId: inactive.id });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "ELECTRICAL_ENGINEER_INACTIVE",
        message: "مهندس الكهرباء هذا غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(villaTables.villas).toHaveLength(0);
    });

    it("refuses an inactive contractor", async () => {
      const inactive = addContractor({ name: "Closed Co", phone: "1", status: "INACTIVE" });

      const res = await asAdmin("post", "", "ar", { ...body(), contractorId: inactive.id });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(villaTables.villas).toHaveLength(0);
    });
  });

  describe("owner and budget", () => {
    it("rejects a currency with no budget, translated, on the currency field", async () => {
      const res = await asAdmin("post", "", "ar", { ...body(), currency: "USD" });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "currency", message: "لا يمكن تحديد العملة إلا مع الميزانية" },
      ]);
    });

    it("rejects a currency beside a null budget", async () => {
      expect(
        (await asAdmin("post", "", "en", { ...body(), budgetMinor: null, currency: "USD" })).status,
      ).toBe(400);
    });

    it.each([
      ["a negative budget", { budgetMinor: -1 }],
      ["a fractional budget", { budgetMinor: 10.5 }],
      ["a budget above 2^53 - 1", { budgetMinor: Number.MAX_SAFE_INTEGER + 2 }],
      ["a budget as text", { budgetMinor: "100" }],
      ["an unknown currency", { budgetMinor: 1, currency: "XXQ" }],
      ["a currency of the wrong length", { budgetMinor: 1, currency: "EG" }],
      ["a blank owner name", { ownerName: "  " }],
      ["an owner name over 120 characters", { ownerName: "x".repeat(121) }],
      ["an electrical engineer id that is not a uuid", { electricalEngineerId: "nope" }],
      ["a date and time instead of a day", { startDate: "2026-01-05T00:00:00Z" }],
    ])("rejects %s with 400 and creates nothing", async (_label, extra) => {
      const res = await asAdmin("post", "", "en", { ...body(), ...extra });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(villaTables.villas).toHaveLength(0);
    });

    it("accepts the largest budget, 2^53 - 1", async () => {
      const res = await asAdmin("post", "", "en", { ...body(), budgetMinor: Number.MAX_SAFE_INTEGER });

      expect(res.status).toBe(201);
      expect(res.body.data.budgetMinor).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("explains the invalid fields in Arabic", async () => {
      const res = await asAdmin("post", "", "ar", {
        ...body(),
        ownerName: " ",
        budgetMinor: -5,
        startDate: "2026-02-30",
      });

      expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual([
        "budgetMinor",
        "ownerName",
        "startDate",
      ]);
      for (const detail of res.body.details) expect(detail.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe("dates", () => {
    it("rejects a target date before the start date, translated", async () => {
      const res = await asAdmin("post", "", "ar", {
        ...body(),
        startDate: "2026-02-01",
        targetDate: "2026-01-31",
      });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "targetDate", message: "يجب ألا يكون التاريخ المستهدف قبل تاريخ البدء" },
      ]);
      expect(villaTables.villas).toHaveLength(0);
    });

    it("accepts equal dates, and a lone target date", async () => {
      expect(
        (
          await asAdmin("post", "", "en", {
            ...body(),
            startDate: "2026-02-01",
            targetDate: "2026-02-01",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await asAdmin("post", "", "en", {
            ...body(),
            villaNumber: "NEW-2",
            plot: "98",
            targetDate: "2020-01-01",
          })
        ).status,
      ).toBe(201);
    });
  });

  it("rolls the villa back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("post", "", "en", { ...body(), contractorId: conA.id });

    expect(res.status).toBe(500);
    expect(villaTables.villas).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  const required = { villaNumber: "N", areaId: AREA_ID, block: "B", plot: "1", civilEngineerId: "e" };
  it.each([
    ["no body", {}],
    ["a missing villa number", { areaId: AREA_ID, block: "B", plot: "1", civilEngineerId: "e" }],
    ["a blank area id", { ...required, areaId: "  " }],
    ["an area name where its id belongs", { ...required, areaId: "New Cairo" }],
    [
      "the old text field area",
      { villaNumber: "N", area: "New Cairo", block: "B", plot: "1", civilEngineerId: "e" },
    ],
    ["no area at all", { villaNumber: "N", block: "B", plot: "1", civilEngineerId: "e" }],
    ["a 51-character block", { ...required, block: "x".repeat(51) }],
    ["an engineer id that is not a uuid", { ...required, civilEngineerId: "nope" }],
    ["a createdById", { ...required, createdById: "x" }],
    ["a contractor id that is not a uuid", { ...required, civilEngineerId: AREA_ID, contractorId: "x" }],
    ["the removed contractorIds list", { ...required, contractorIds: [] }],
    ["the removed activities", { ...required, activities: [] }],
    ["the removed status", { ...required, status: "OPEN" }],
    ["the removed checklist flag", { ...required, checklistCompleted: true }],
    ["the removed material request flag", { ...required, materialRequested: true }],
    ["the old plotNumber", { ...required, plotNumber: "1" }],
    ["an invalid date", { ...required, startDate: "2026-02-30" }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await asAdmin("post", "", "en", payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(villaTables.villas).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("explains the problems in Arabic, once per field", async () => {
    const res = await asAdmin("post", "", "ar", {
      villaNumber: " ",
      areaId: AREA_ID,
      block: "B",
      plot: "1",
      civilEngineerId: "nope",
      contractorId: "nope",
    });

    expect(res.body.message).toBe("فشل التحقق");
    expect(res.body.details).toEqual([
      { path: "villaNumber", message: "يجب أن يكون الطول بين 1 و50 حرفًا" },
      { path: "civilEngineerId", message: "معرّف غير صالح" },
      { path: "contractorId", message: "معرّف غير صالح" },
    ]);
  });
});

describe("PATCH /villas/:id", () => {
  let p1: ReturnType<typeof addVilla>;
  beforeEach(() => {
    ({ p1 } = seed());
  });

  const patch = (body: unknown, id = p1.id, language = "en") => asAdmin("patch", `/${id}`, language, body);

  it("changes the fields that were sent, and leaves the others", async () => {
    const res = await patch({ block: "B7", areaId: areaNamed("Zayed") });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      block: "B7",
      area: "Zayed",
      areaId: areaNamed("Zayed"),
      plot: "10",
      contractor: { id: conA.id, name: "Nile Builders" },
    });
    expect(stored("P-001")).toMatchObject({ startDate: day("2026-01-05"), contractorId: conA.id });
  });

  it("changes the engineer and the dates (including clearing one)", async () => {
    const res = await patch({ civilEngineerId: eng2.id, startDate: "2026-01-10", targetDate: null });

    expect(res.body.data).toMatchObject({
      civilEngineer: { id: eng2.id, name: "Omar Said" },
      startDate: "2026-01-10",
      targetDate: null,
    });
  });

  describe("owner, electrical engineer and budget", () => {
    it("changes the owner and clears it with null", async () => {
      expect((await patch({ ownerName: " Samir Fahmy " })).body.data.ownerName).toBe("Samir Fahmy");
      expect((await patch({ ownerName: null })).body.data.ownerName).toBeNull();
    });

    it("changes and clears the electrical engineer", async () => {
      const changed = await patch({ electricalEngineerId: elec2.id });
      expect(changed.body.data.electricalEngineer).toEqual({ id: elec2.id, name: "Tarek Nabil" });

      const cleared = await patch({ electricalEngineerId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.electricalEngineer).toBeNull();
      expect(stored("P-001")?.electricalEngineerId).toBeNull();
    });

    it("answers 404 for an unknown electrical engineer, and changes nothing", async () => {
      const res = await patch({ electricalEngineerId: MISSING_ID, block: "B7" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELECTRICAL_ENGINEER_NOT_FOUND");
      expect(stored("P-001")).toMatchObject({ block: "B1", electricalEngineerId: elec1.id });
    });

    it("changes the budget and keeps the currency", async () => {
      const res = await patch({ budgetMinor: 999 });

      expect(res.body.data).toMatchObject({ budgetMinor: 999, currency: "EGP" });
    });

    it("changes the budget and the currency together", async () => {
      const res = await patch({ budgetMinor: 999, currency: "usd" });

      expect(res.body.data).toMatchObject({ budgetMinor: 999, currency: "USD" });
    });

    it("clears the budget and its currency together with a null budget", async () => {
      const res = await patch({ budgetMinor: null });

      expect(res.body.data).toMatchObject({ budgetMinor: null, currency: null });
      expect(stored("P-001")).toMatchObject({ budgetMinor: null, currency: null });
    });

    it("gives a first budget on a villa that has none the currency KWD", async () => {
      const { p2 } = { p2: stored("P-002")! };

      const res = await patch({ budgetMinor: 70 }, p2.id);

      expect(res.body.data).toMatchObject({ budgetMinor: 70, currency: "KWD" });
    });

    it("refuses a currency alone on a villa that has no budget", async () => {
      const { p2 } = { p2: stored("P-002")! };

      const res = await patch({ currency: "USD" }, p2.id, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "currency", message: "لا يمكن تحديد العملة إلا مع الميزانية" },
      ]);
      expect(p2.currency).toBeNull();
    });

    it("changes only the currency of a villa that has a budget", async () => {
      const res = await patch({ currency: "USD" });

      expect(res.body.data).toMatchObject({ budgetMinor: 125050, currency: "USD" });
    });

    it("refuses a currency beside a null budget", async () => {
      expect((await patch({ budgetMinor: null, currency: "USD" })).status).toBe(400);
    });

    it.each([
      ["a negative budget", { budgetMinor: -1 }],
      ["a fractional budget", { budgetMinor: 1.5 }],
      ["an unknown currency", { currency: "XXQ" }],
      ["a blank owner", { ownerName: " " }],
      ["a date and time", { targetDate: "2026-03-01T00:00:00Z" }],
    ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
      const res = await patch(payload);

      expect(res.status).toBe(400);
      expect(stored("P-001")).toMatchObject({
        budgetMinor: 125050,
        currency: "EGP",
        ownerName: "Khaled Mansour",
      });
      expect(auditRows()).toHaveLength(0);
    });
  });

  describe("inactive parties are refused only when set or changed", () => {
    it("refuses changing to an inactive civil engineer, electrical engineer or contractor", async () => {
      const civil = addEngineer({ name: "Out", status: "INACTIVE" });
      const electrical = addElectricalEngineer({ name: "Out", status: "INACTIVE" });
      const contractor = addContractor({ name: "Out", phone: "1", status: "INACTIVE" });

      expect((await patch({ civilEngineerId: civil.id })).body.code).toBe("CIVIL_ENGINEER_INACTIVE");
      expect((await patch({ electricalEngineerId: electrical.id })).body.code).toBe(
        "ELECTRICAL_ENGINEER_INACTIVE",
      );
      expect((await patch({ contractorId: contractor.id }, p1.id, "ar")).body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(stored("P-001")).toMatchObject({
        civilEngineerId: eng1.id,
        electricalEngineerId: elec1.id,
        contractorId: conA.id,
      });
      expect(auditRows()).toHaveLength(0);
    });

    it("lets a villa keep its parties after they go inactive, when the field is not changed", async () => {
      eng1.status = "INACTIVE";
      elec1.status = "INACTIVE";
      conA.status = "INACTIVE";

      const res = await patch({ block: "B7", civilEngineerId: eng1.id, contractorId: conA.id });

      expect(res.status).toBe(200);
      expect(res.body.data.block).toBe("B7");
    });

    it("lets a villa clear an inactive party", async () => {
      conA.status = "INACTIVE";
      elec1.status = "INACTIVE";

      const res = await patch({ contractorId: null, electricalEngineerId: null });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ contractor: null, electricalEngineer: null });
    });
  });

  it("returns the list shape, without the engineer's or contractor's phone numbers", async () => {
    const res = await patch({ block: "B7" });

    expect(JSON.stringify(res.body)).not.toMatch(/phone/);
  });

  it("moves updatedAt and the version forward", async () => {
    const before = p1.updatedAt.getTime();

    const res = await patch({ block: "B7" });

    expect(Date.parse(res.body.data.updatedAt)).toBeGreaterThan(before);
    expect(res.body.data.version).toBe(2);
  });

  describe("contractor", () => {
    it("sets, changes and clears the villa's one contractor", async () => {
      const { p4 } = { p4: stored("P-004")! };

      const set = await patch({ contractorId: conC.id }, p4.id);
      expect(set.body.data.contractor).toEqual({ id: conC.id, name: "Giza Co" });

      const changed = await patch({ contractorId: conB.id }, p4.id);
      expect(changed.body.data.contractor).toEqual({ id: conB.id, name: "Delta Works" });

      const cleared = await patch({ contractorId: null }, p4.id);
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.contractor).toBeNull();
      expect(p4.contractorId).toBeNull();
    });

    it("leaves the contractor alone when contractorId is not sent", async () => {
      await patch({ block: "B7" });

      expect(stored("P-001")?.contractorId).toBe(conA.id);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for an unknown contractor, in Arabic, and changes nothing", async () => {
      const res = await patch({ contractorId: MISSING_ID, block: "B7" }, p1.id, "ar");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
      expect(stored("P-001")).toMatchObject({ contractorId: conA.id, block: "B1" });
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 404 when the new contractor is deleted mid-request (race)", async () => {
      villaTables.beforeWrite = () => {
        contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== conC.id);
      };

      const res = await patch({ contractorId: conC.id });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(stored("P-001")?.contractorId).toBe(conA.id);
    });

    it("rejects the removed contractorIds list", async () => {
      expect((await patch({ contractorIds: [conB.id] })).status).toBe(400);
    });
  });

  describe("uniqueness", () => {
    it("answers 409 for a villa number or plot taken by another villa", async () => {
      expect((await patch({ villaNumber: "P-002" })).body).toMatchObject({ code: "VILLA_NUMBER_TAKEN" });
      expect((await patch({ areaId: p1.areaId, block: "B2", plot: "11" })).body).toMatchObject({
        code: "VILLA_PLOT_TAKEN",
      });
      expect(stored("P-001")).toMatchObject({ villaNumber: "P-001", block: "B1", plot: "10" });
    });

    it("allows a villa to keep its own number and plot", async () => {
      expect(
        (
          await patch({
            villaNumber: "P-001",
            areaId: p1.areaId,
            block: "B1",
            plot: "10",
            startDate: "2026-01-06",
          })
        ).status,
      ).toBe(200);
    });

    it("answers 409 when another request takes the number mid-request (race)", async () => {
      villaTables.beforeWrite = () => {
        addVilla({ villaNumber: "P-NEW", area: "Racer", plot: "1" });
      };

      const res = await patch({ villaNumber: "P-NEW" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VILLA_NUMBER_TAKEN");
    });
  });

  describe("references", () => {
    it("moves the villa to another area, which answers with its name and id", async () => {
      const moved = addArea({ name: "Zayed", city: "Giza" });
      const originalAreaId = p1.areaId;

      const res = await patch({ areaId: moved.id });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ area: "Zayed", areaId: moved.id });
      expect(stored("P-001")?.areaId).toBe(moved.id);
      expect(auditRows()[0]).toMatchObject({
        action: "villa.update",
        before: { areaId: originalAreaId },
        after: { areaId: moved.id },
      });
    });

    it("answers 404 AREA_NOT_FOUND for a new area that does not exist, in Arabic, and changes nothing", async () => {
      const res = await patch({ areaId: MISSING_ID, block: "B7" }, p1.id, "ar");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "AREA_NOT_FOUND", message: "المنطقة غير موجودة" });
      expect(stored("P-001")).toMatchObject({ block: "B1", areaId: areaNamed("New Cairo") });
      expect(auditRows()).toHaveLength(0);
    });

    it("answers 404 CIVIL_ENGINEER_NOT_FOUND for an unknown new engineer", async () => {
      const res = await patch({ civilEngineerId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CIVIL_ENGINEER_NOT_FOUND");
      expect(stored("P-001")?.civilEngineerId).toBe(eng1.id);
    });

    it("answers 404 when the new engineer is deleted mid-request (race)", async () => {
      villaTables.beforeWrite = () => {
        engineerTables.engineers = engineerTables.engineers.filter((e) => e.id !== eng2.id);
      };

      const res = await patch({ civilEngineerId: eng2.id });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CIVIL_ENGINEER_NOT_FOUND");
    });
  });

  describe("the date rule is checked against the values the villa will have", () => {
    it("rejects a target date earlier than the stored start date", async () => {
      const res = await patch({ targetDate: "2026-01-04" }, p1.id, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "targetDate", message: "يجب ألا يكون التاريخ المستهدف قبل تاريخ البدء" },
      ]);
      expect(stored("P-001")?.targetDate).toEqual(day("2026-03-01"));
    });

    it("rejects a start date later than the stored target date", async () => {
      expect((await patch({ startDate: "2026-03-02" })).status).toBe(400);
    });

    it("rejects an inverted pair sent together", async () => {
      expect((await patch({ startDate: "2026-05-02", targetDate: "2026-05-01" })).status).toBe(400);
    });

    it("accepts moving both dates, equal dates, and clearing one", async () => {
      expect((await patch({ startDate: "2026-05-01", targetDate: "2026-06-01" })).status).toBe(200);
      expect((await patch({ targetDate: "2026-05-01" })).status).toBe(200);
      expect((await patch({ startDate: null })).status).toBe(200);
      expect((await patch({ targetDate: "2000-01-01" })).status).toBe(200);
    });
  });

  describe("audit", () => {
    it("records only the fields that really changed, with old and new values", async () => {
      await patch({ block: "B7", areaId: p1.areaId, startDate: "2026-02-01" });

      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        action: "villa.update",
        entity: "Villa",
        actorId: admin.id,
        entityId: p1.id,
        before: { block: "B1", startDate: "2026-01-05" },
        after: { block: "B7", startDate: "2026-02-01" },
      });
      expect(auditRows()[0]?.["before"]).not.toHaveProperty("areaId");
    });

    it("records the owner, electrical engineer and budget changes", async () => {
      await patch({
        ownerName: "Samir Fahmy",
        electricalEngineerId: elec2.id,
        budgetMinor: 1,
        currency: "USD",
      });

      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        before: {
          ownerName: "Khaled Mansour",
          electricalEngineerId: elec1.id,
          budgetMinor: 125050,
          currency: "EGP",
        },
        after: { ownerName: "Samir Fahmy", electricalEngineerId: elec2.id, budgetMinor: 1, currency: "USD" },
      });
    });

    it("records clearing the budget as null for both fields", async () => {
      await patch({ budgetMinor: null });

      expect(auditRows()[0]).toMatchObject({
        before: { budgetMinor: 125050, currency: "EGP" },
        after: { budgetMinor: null, currency: null },
      });
    });

    it("records the contractor change, and clearing it as null", async () => {
      await patch({ contractorId: conC.id });
      await patch({ contractorId: null });

      expect(auditRows()[0]).toMatchObject({
        before: { contractorId: conA.id },
        after: { contractorId: conC.id },
      });
      expect(auditRows()[1]).toMatchObject({
        before: { contractorId: conC.id },
        after: { contractorId: null },
      });
    });

    it("writes no entry when the request is rejected", async () => {
      await patch({ villaNumber: "P-002" });
      await patch({ targetDate: "2026-01-01" });

      expect(auditRows()).toHaveLength(0);
    });
  });

  it("rolls the change back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await patch({ block: "B7", contractorId: conC.id });

    expect(res.status).toBe(500);
    expect(stored("P-001")).toMatchObject({ block: "B1", contractorId: conA.id });
  });

  it("answers 404 for an unknown villa (also when it is deleted mid-request), and 400 for a malformed id", async () => {
    expect((await patch({ block: "B7" }, MISSING_ID, "ar")).body).toMatchObject({
      code: "VILLA_NOT_FOUND",
      message: "الفيلا غير موجودة",
    });
    expect((await patch({ block: "B7" }, "nope")).status).toBe(400);

    villaTables.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((p) => p.id !== p1.id);
    };
    expect((await patch({ block: "B7" })).body.code).toBe("VILLA_NOT_FOUND");
  });

  it.each([
    ["an empty body", {}],
    ["createdBy", { createdBy: "x" }],
    ["createdById", { createdById: MISSING_ID }],
    ["the removed status", { status: "CLOSED" }],
    ["the removed flags", { checklistCompleted: true, materialRequested: true }],
    ["the removed activities", { activities: [] }],
    ["an id", { id: MISSING_ID }],
    ["an unknown field", { block: "B7", files: [] }],
    ["a blank area id", { areaId: " " }],
    ["an area name where its id belongs", { areaId: "Zayed" }],
    ["the old text field area", { area: "Zayed" }],
    ["the old plotNumber", { plotNumber: "5" }],
    ["a contractor id that is not a uuid", { contractorId: "x" }],
    ["an invalid date", { startDate: "31/01/2026" }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const res = await patch(payload);

    expect(res.status).toBe(400);
    expect(stored("P-001")).toMatchObject({ block: "B1", areaId: areaNamed("New Cairo") });
    expect(auditRows()).toHaveLength(0);
  });

  it("explains an empty update in Arabic", async () => {
    const res = await patch({}, p1.id, "ar");

    expect(res.body.details[0].message).toBe("يجب تقديم حقل واحد على الأقل للتحديث");
  });
});

describe("DELETE /villas/:id", () => {
  it("deletes with 204 and no body, and its documents go with it", async () => {
    const { p1 } = seed();
    villaTables.documents.push({
      id: randomUUID(),
      villaId: p1.id,
      storageKey: `villas/${p1.id}/${randomUUID()}.pdf`,
      originalName: "plan.pdf",
      sizeBytes: 1,
      mimeType: "application/pdf",
      uploadedById: admin.id,
      createdAt: new Date(),
    });

    const res = await asAdmin("delete", `/${p1.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(villaTables.villas.some((p) => p.id === p1.id)).toBe(false);
    expect(villaTables.documents.some((d) => d.villaId === p1.id)).toBe(false);
  });

  it("leaves the other villas, and the engineers, contractors and areas, in place", async () => {
    const { p1 } = seed();
    const others = villaTables.villas.length - 1;

    await asAdmin("delete", `/${p1.id}`);

    expect(villaTables.villas).toHaveLength(others);
    expect(engineerTables.engineers).toHaveLength(2);
    expect(contractorTables.contractors).toHaveLength(3);
    expect(areaTables.areas).toHaveLength(3);
  });

  it("audits the full snapshot, including the contractor, and no `after`", async () => {
    const { p1 } = seed();

    await asAdmin("delete", `/${p1.id}`);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "villa.delete",
      entity: "Villa",
      actorId: admin.id,
      entityId: p1.id,
      before: {
        villaNumber: "P-001",
        areaId: p1.areaId,
        block: "B1",
        plot: "10",
        ownerName: "Khaled Mansour",
        civilEngineerId: eng1.id,
        electricalEngineerId: elec1.id,
        contractorId: conA.id,
        startDate: "2026-01-05",
        targetDate: "2026-03-01",
        budgetMinor: 125050,
        currency: "EGP",
      },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("answers 404 for an unknown villa in Arabic, and 400 for a malformed id", async () => {
    const missing = await asAdmin("delete", `/${MISSING_ID}`, "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
    expect((await asAdmin("delete", "/nope")).status).toBe(400);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 when another request deletes it first (race), and writes no audit entry", async () => {
    const { p1 } = seed();
    villaTables.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((p) => p.id !== p1.id);
    };

    const res = await asAdmin("delete", `/${p1.id}`);

    expect(res.status).toBe(404);
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the delete back when the audit write fails", async () => {
    const { p1 } = seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("delete", `/${p1.id}`);

    expect(res.status).toBe(500);
    expect(villaTables.villas.some((p) => p.id === p1.id)).toBe(true);
  });

  it("lets only the holder of villas:delete delete", async () => {
    const { p2 } = seed();

    const denied = await call("delete", `/${p2.id}`).set(
      await as(employee("u@example.test", "villas:update", "villas:read", "villas:detail")),
    );
    const allowed = await call("delete", `/${p2.id}`).set(
      await as(employee("d@example.test", "villas:delete")),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
  });
});

describe("audit trail", () => {
  it("records create, update and delete in order, each with the actor and a request id", async () => {
    const created = await asAdmin("post", "", "en", {
      villaNumber: "T-1",
      areaId: areaNamed("A"),
      block: "B",
      plot: "1",
      civilEngineerId: eng1.id,
    });
    const id = created.body.data.id as string;
    await asAdmin("patch", `/${id}`, "en", { block: "C" });
    await asAdmin("delete", `/${id}`);

    expect(auditRows().map((row) => row["action"])).toEqual(["villa.create", "villa.update", "villa.delete"]);
    for (const row of auditRows()) {
      expect(row).toMatchObject({ actorId: admin.id, entity: "Villa", entityId: id });
      expect(row["requestId"]).toEqual(expect.any(String));
    }
  });

  it("never records anything but villa fields, ids and ISO dates", async () => {
    await asAdmin("post", "", "en", {
      villaNumber: "T-1",
      areaId: areaNamed("A"),
      block: "B",
      plot: "1",
      civilEngineerId: eng1.id,
      contractorId: conA.id,
    });

    expect(JSON.stringify(auditRows())).not.toMatch(/phone|password|token/i);
  });
});
