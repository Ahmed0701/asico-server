import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { addDailyLabour } from "../daily-labour/in-memory-daily-labour.repository.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { addContractor, addVilla, contractorTables, linkVilla } from "./in-memory-contractors.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/contractors/repository/contractors.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/contractors/repository/contractors.repository.js")
  >()),
  ContractorsRepository: (await import("./in-memory-contractors.repository.js"))
    .InMemoryContractorsRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  contractorTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
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
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1/contractors${path}`);

const asAdmin = async (verb: Verb, path: string, language = "en", body?: unknown) => {
  const req = call(verb, path)
    .set(await as(admin))
    .set("Accept-Language", language);
  return body === undefined ? req : req.send(body as object);
};

const names = (res: request.Response): string[] => res.body.data.map((item: { name: string }) => item.name);
const numbers = (res: request.Response): string[] =>
  res.body.data.villas.map((p: { villaNumber: string }) => p.villaNumber);
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "contractors:read"],
    ["get", "/options", "contractors:read"],
    ["get", `/${MISSING_ID}`, "contractors:read"],
    ["get", `/${MISSING_ID}/summary`, "contractors:summary"],
    ["post", "", "contractors:create"],
    ["patch", `/${MISSING_ID}`, "contractors:update"],
    ["delete", `/${MISSING_ID}`, "contractors:delete"],
  ];
  const allCodes = [
    "contractors:read",
    "contractors:create",
    "contractors:update",
    "contractors:delete",
    "contractors:summary",
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
    "%s %s is not opened by any of the other contractors permissions",
    async (verb, path, needed) => {
      const others = allCodes.filter((code) => code !== needed).concat("civil-engineers:read", "villas:read");

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

  it("does not let contractors:read open the summary, nor contractors:summary open the contractor", async () => {
    const con = addContractor({ name: "Nile Builders" });
    const reader = await as(employee("r@example.test", "contractors:read"));
    const summarizer = await as(employee("s@example.test", "contractors:summary"));

    expect((await call("get", `/${con.id}/summary`).set(reader)).status).toBe(403);
    expect((await call("get", `/${con.id}`).set(summarizer)).status).toBe(403);
    expect((await call("get", `/${con.id}/summary`).set(summarizer)).status).toBe(200);
    expect((await call("get", `/${con.id}`).set(reader)).status).toBe(200);
  });

  it("checks access before validating", async () => {
    const res = await call("post", "")
      .set(await as(employee("e@example.test")))
      .send({ nonsense: true });

    expect(res.status).toBe(403);
  });
});

describe("GET /contractors", () => {
  beforeEach(() => {
    const at = (iso: string) => new Date(iso);
    addContractor({ name: "Alpha Works", phone: "0100 111 2222", createdAt: at("2026-01-05T00:00:00Z") });
    const bravo = addContractor({
      name: "Bravo Build",
      phone: "+20 101 333 4444",
      createdAt: at("2026-01-03T00:00:00Z"),
    });
    addContractor({ name: "Charlie Co", phone: "0102-555-6666", createdAt: at("2026-01-04T00:00:00Z") });
    const delta = addContractor({
      name: "Delta Dev",
      phone: "0103 777 8888",
      createdAt: at("2026-01-02T00:00:00Z"),
    });
    addContractor({ name: "Echo Eng", phone: "0104 999 0000", createdAt: at("2026-01-01T00:00:00Z") });
    linkVilla(bravo.id, addVilla().id);
    linkVilla(bravo.id, addVilla().id);
    linkVilla(delta.id, addVilla().id);
  });

  it("returns the contractors by name, with villaCount and the shared pagination meta", async () => {
    const res = await asAdmin("get", "");

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Alpha Works", "Bravo Build", "Charlie Co", "Delta Dev", "Echo Eng"]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    expect(res.body.data.map((item: { villaCount: number }) => item.villaCount)).toEqual([0, 2, 0, 1, 0]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["createdAt", "email", "id", "name", "phone", "villaCount", "status", "updatedAt", "version"].sort(),
    );
  });

  it("pages with limit and page", async () => {
    const second = await asAdmin("get", "?limit=2&page=2");

    expect(names(second)).toEqual(["Charlie Co", "Delta Dev"]);
    expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(names(await asAdmin("get", "?limit=2&page=4"))).toEqual([]);
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

  it("searches name or phone, case-insensitively and trimmed", async () => {
    expect(names(await asAdmin("get", "?search=ALPHA"))).toEqual(["Alpha Works"]);
    expect(names(await asAdmin("get", "?search=%20%20bravo%20"))).toEqual(["Bravo Build"]);
    expect(names(await asAdmin("get", "?search=0102"))).toEqual(["Charlie Co"]);
    expect(names(await asAdmin("get", "?search=%2B20"))).toEqual(["Bravo Build"]);
    const none = await asAdmin("get", "?search=zzz");
    expect(none.body.data).toEqual([]);
    expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("rejects a search longer than 100 characters", async () => {
    expect((await asAdmin("get", `?search=${"x".repeat(101)}`, "ar")).status).toBe(400);
  });

  it.each([
    ["name:desc", ["Echo Eng", "Delta Dev", "Charlie Co", "Bravo Build", "Alpha Works"]],
    ["createdAt", ["Echo Eng", "Delta Dev", "Bravo Build", "Charlie Co", "Alpha Works"]],
    ["createdAt:desc", ["Alpha Works", "Charlie Co", "Bravo Build", "Delta Dev", "Echo Eng"]],
  ])("sorts by %s", async (sort, expected) => {
    expect(names(await asAdmin("get", `?sort=${sort}`))).toEqual(expected);
  });

  it.each(["phone", "id:asc", "villaCount", "name:up", ":asc"])(
    "rejects sort=%j with 400 and a translated message",
    async (sort) => {
      const res = await asAdmin("get", `?sort=${encodeURIComponent(sort)}`, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("sort");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    },
  );
});

describe("GET /contractors/options", () => {
  it("is not mistaken for an id, and is empty when there are none", async () => {
    const res = await asAdmin("get", "/options");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns only id and name, sorted by name, without meta", async () => {
    const zed = addContractor({ name: "Zed" });
    const amy = addContractor({ name: "Amy" });

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toEqual([
      { id: amy.id, name: "Amy" },
      { id: zed.id, name: "Zed" },
    ]);
    expect(res.body).not.toHaveProperty("meta");
    expect(JSON.stringify(res.body)).not.toMatch(/phone|must not leak/);
  });

  it("returns at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++) {
      addContractor({ name: `Contractor ${String(i).padStart(4, "0")}` });
    }

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toHaveLength(1000);
    expect(res.body.data[999].name).toBe("Contractor 0999");
  });
});

describe("GET /contractors/:id", () => {
  it("returns the contractor in the same shape as the list", async () => {
    const con = addContractor({ name: "Nile Builders", phone: "0100 123 4567" });
    linkVilla(con.id, addVilla().id);
    linkVilla(con.id, addVilla().id);

    const res = await asAdmin("get", `/${con.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: con.id, name: "Nile Builders", villaCount: 2 });
  });

  it("answers 404 CONTRACTOR_NOT_FOUND in Arabic, and 400 for a malformed id", async () => {
    const missing = await asAdmin("get", `/${MISSING_ID}`, "ar");
    const malformed = await asAdmin("get", "/not-a-uuid", "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("GET /contractors/:id/summary", () => {
  let con: ReturnType<typeof addContractor>;
  let other: ReturnType<typeof addContractor>;

  beforeEach(() => {
    con = addContractor({ name: "Nile Builders", phone: "+20 100 123 4567" });
    other = addContractor({ name: "Other Co" });
    const d = (iso: string | null) => (iso ? new Date(iso) : null);
    const mk = (n: string, owner: { id: string }, started: string | null, target: string | null) =>
      addVilla({
        villaNumber: n,
        contractorId: owner.id,
        startDate: d(started),
        targetDate: d(target),
        area: "New Cairo",
        block: "B1",
        plot: n,
      });
    mk("P-001", con, "2026-01-05T00:00:00Z", "2026-03-01T00:00:00Z");
    mk("P-002", con, null, "2026-02-01T00:00:00Z");
    mk("P-003", con, "2026-01-03T00:00:00Z", null);
    mk("P-004", con, "2026-01-04T00:00:00Z", "2026-02-15T00:00:00Z");
    mk("P-005", con, null, null);
    mk("P-006", con, "2026-01-02T00:00:00Z", "2026-01-20T00:00:00Z");
    mk("P-007", con, "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z");
    // A villa has one contractor, so the other contractor's villa is a separate one.
    mk("P-100", other, null, null);
  });

  const summary = (query = "", language = "en") => asAdmin("get", `/${con.id}/summary${query}`, language);

  it("returns the contractor, the villa count, the villas and a top-level meta beside data", async () => {
    const res = await summary();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["data", "meta"]);
    expect(Object.keys(res.body.data).sort()).toEqual([
      "contractor",
      "dailyReports",
      "labour",
      "openWorks",
      "smallWorks",
      "villaCount",
      "villas",
    ]);
    expect(res.body.data.contractor).toEqual({
      id: con.id,
      name: "Nile Builders",
      phone: "+20 100 123 4567",
    });
    expect(res.body.data.villaCount).toBe(7);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 7, totalPages: 1 });
    expect(numbers(res)).toEqual(["P-001", "P-002", "P-003", "P-004", "P-005", "P-006", "P-007"]);
  });

  it("gives each villa its documented shape, with calendar days and nulls, and no status or assigned date", async () => {
    const res = await summary();

    expect(res.body.data.villas[0]).toEqual({
      id: expect.any(String),
      villaNumber: "P-001",
      area: "New Cairo",
      block: "B1",
      plot: "P-001",
      startDate: "2026-01-05",
      targetDate: "2026-03-01",
    });
    expect(res.body.data.villas[1]).toMatchObject({ villaNumber: "P-002", startDate: null });
    expect(res.body.data.villas[2]).toMatchObject({ villaNumber: "P-003", targetDate: null });
    expect(res.body.data).not.toHaveProperty("totals");
  });

  it("never shows another contractor's villas", async () => {
    const mine = await summary();
    const theirs = await asAdmin("get", `/${other.id}/summary`);

    expect(numbers(mine)).not.toContain("P-100");
    expect(numbers(theirs)).toEqual(["P-100"]);
    expect(theirs.body.data.villaCount).toBe(1);
  });

  it("pages the list, and the villa count stays the total on every page", async () => {
    const first = await summary("?limit=3&page=1");
    const last = await summary("?limit=3&page=3");

    expect(numbers(first)).toEqual(["P-001", "P-002", "P-003"]);
    expect(numbers(last)).toEqual(["P-007"]);
    expect(last.body.meta).toEqual({ page: 3, limit: 3, total: 7, totalPages: 3 });
    expect(first.body.data.villaCount).toBe(7);
    expect(last.body.data.villaCount).toBe(7);
  });

  it.each([
    ["villaNumber:desc", ["P-007", "P-006", "P-005", "P-004", "P-003", "P-002", "P-001"]],
    // Villas without a date come last, in both directions, ordered by villa number among themselves.
    ["startDate", ["P-007", "P-006", "P-003", "P-004", "P-001", "P-002", "P-005"]],
    ["startDate:asc", ["P-007", "P-006", "P-003", "P-004", "P-001", "P-002", "P-005"]],
    ["startDate:desc", ["P-001", "P-004", "P-003", "P-006", "P-007", "P-002", "P-005"]],
    ["targetDate:asc", ["P-007", "P-006", "P-002", "P-004", "P-001", "P-003", "P-005"]],
    ["targetDate:desc", ["P-001", "P-004", "P-002", "P-006", "P-007", "P-003", "P-005"]],
  ])("sorts by %s", async (sort, expected) => {
    expect(numbers(await summary(`?sort=${sort}`))).toEqual(expected);
  });

  it("combines sort and paging", async () => {
    const res = await summary("?sort=startDate:desc&limit=2");

    expect(numbers(res)).toEqual(["P-001", "P-004"]);
    expect(res.body.meta.total).toBe(7);
  });

  it("reports a count of zero and an empty list for a contractor with no villas", async () => {
    const empty = addContractor({ name: "No Villas" });

    const res = await asAdmin("get", `/${empty.id}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.data.villaCount).toBe(0);
    expect(res.body.data.villas).toEqual([]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("accepts a limit of 1000 and rejects 1001 with 400, in Arabic", async () => {
    expect((await summary("?limit=1000")).status).toBe(200);

    const res = await summary("?limit=1001", "ar");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(res.body.details[0].path).toBe("limit");
  });

  it.each(["0", "-1", "abc"])("rejects limit=%j with 400", async (value) => {
    expect((await summary(`?limit=${value}`)).status).toBe(400);
  });

  it("no longer filters by status: the parameter is ignored", async () => {
    const res = await summary("?status=CLOSED");

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(7);
  });

  it.each(["name", "assignedAt", "status:asc", "startDate:up", ":asc"])(
    "rejects sort=%j with 400 and a translated message",
    async (sort) => {
      const res = await summary(`?sort=${encodeURIComponent(sort)}`, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("sort");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    },
  );

  it("answers 404 for an unknown contractor in Arabic, and 400 for a malformed id", async () => {
    const missing = await asAdmin("get", `/${MISSING_ID}/summary`, "ar");
    const malformed = await asAdmin("get", "/nope/summary");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
    expect(malformed.status).toBe(400);
  });

  it("is read-only: asking for it writes no audit entry and changes no data", async () => {
    const before = JSON.stringify(contractorTables);

    await summary();
    await summary("?sort=startDate:desc");

    expect(auditRows()).toHaveLength(0);
    expect(JSON.stringify(contractorTables)).toBe(before);
  });

  it("opens for the holder of contractors:summary alone, without villas:read", async () => {
    const res = await call("get", `/${con.id}/summary`).set(
      await as(employee("s@example.test", "contractors:summary")),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.villas).toHaveLength(7);
  });

  describe("the work of the contractor in the other resources", () => {
    const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const stamp = { createdById: null, version: 1, createdAt: new Date(), updatedAt: new Date() };
    const FAR_PAST = "2000-01-01";
    const FAR_FUTURE = "2999-01-01";

    beforeEach(() => {
      const [villa] = contractorTables.villas;
      const base = { villaId: villa!.id, ...stamp };
      const item = (status: "NOT_STARTED" | "IN_PROGRESS" | "DELAYED" | "DONE", endDate: string | null) =>
        workItemTables.items.push({
          id: randomUUID(),
          elecPhaseId: randomUUID(),
          priority: "MEDIUM",
          progress: 0,
          contractorId: con.id,
          startDate: null,
          endDate: endDate === null ? null : at(endDate),
          source: "MANUAL",
          status,
          ...base,
        });
      item("NOT_STARTED", FAR_PAST); // overdue
      item("IN_PROGRESS", FAR_FUTURE);
      item("DELAYED", FAR_PAST); // overdue and delayed
      item("DONE", FAR_PAST); // done is never overdue
      item("DONE", null);
      // The other contractor's work is never counted.
      workItemTables.items.push({ ...workItemTables.items[0]!, id: randomUUID(), contractorId: other.id });

      const small = (status: "PENDING" | "DONE", endDate: string) =>
        smallWorkTables.works.push({
          id: randomUUID(),
          contractorId: con.id,
          startDate: at(FAR_PAST),
          endDate: at(endDate),
          description: "work",
          status,
          ...base,
        });
      small("PENDING", FAR_PAST); // overdue
      small("PENDING", FAR_FUTURE);
      small("DONE", FAR_PAST);

      for (const date of ["2026-02-01", "2026-02-09", "2026-02-05"]) {
        dailyReportTables.reports.push({
          id: randomUUID(),
          contractorId: con.id,
          preparedByEngineerId: randomUUID(),
          reportDate: at(date),
          weather: "SUNNY",
          workersCount: 4,
          notes: null,
          ...stamp,
        });
      }
      for (const [date, count] of [
        ["2026-03-01", 10],
        ["2026-03-04", 25],
      ] as const) {
        addDailyLabour({
          villaId: villa!.id,
          contractorId: con.id,
          labourDate: at(date),
          labourCount: count,
        });
      }
    });

    const sections = ["openWorks", "smallWorks", "dailyReports", "labour"] as const;
    type Section = (typeof sections)[number];
    const sectionOf = async (user: User) => {
      const res = await call("get", `/${con.id}/summary`).set(await as(user));
      expect(res.status).toBe(200);
      return res.body.data as Record<Section, unknown>;
    };

    it("gives an ADMIN every section with every number", async () => {
      const data = (await summary()).body.data;

      expect(data.openWorks).toEqual({
        total: 5,
        byStatus: { NOT_STARTED: 1, IN_PROGRESS: 1, DELAYED: 1, DONE: 2 },
        delayed: 1,
        overdue: 2,
      });
      expect(data.smallWorks).toEqual({ total: 3, pending: 2, done: 1, overdue: 1, dueSoon: 0 });
      expect(data.dailyReports).toEqual({ count: 3, lastReportDate: "2026-02-09" });
      expect(data.labour).toEqual({ entries: 2, totalLabour: 35, lastLabourDate: "2026-03-04" });
    });

    it("gives null sections to a holder of contractors:summary alone", async () => {
      const data = await sectionOf(employee("only@example.test", "contractors:summary"));

      for (const name of sections) expect(data[name]).toBeNull();
    });

    it.each([
      ["open-works:read", "openWorks"],
      ["small-works:read", "smallWorks"],
      ["daily-reports:read", "dailyReports"],
      ["daily-labour:read", "labour"],
    ] as const)("%s opens the %s section and no other", async (code, opened) => {
      const data = await sectionOf(employee(`${opened}@example.test`, "contractors:summary", code));

      for (const name of sections) {
        if (name === opened) expect(data[name]).not.toBeNull();
        else expect(data[name]).toBeNull();
      }
    });

    it("gives an employee with all four read permissions the same numbers as the ADMIN", async () => {
      const everything = employee(
        "all@example.test",
        "contractors:summary",
        "open-works:read",
        "small-works:read",
        "daily-reports:read",
        "daily-labour:read",
      );

      const adminData = (await summary()).body.data;
      const data = await sectionOf(everything);
      for (const name of sections) expect(data[name]).toEqual(adminData[name]);
    });
  });
});

describe("POST /contractors", () => {
  const body = { name: "Nile Builders", phone: "0100 123 4567" };

  it("creates the contractor with villaCount 0, trimming the input", async () => {
    const res = await asAdmin("post", "", "en", { name: "  Nile Builders  ", phone: "  +20 100-123 4567 " });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Nile Builders",
      phone: "+20 100-123 4567",
      villaCount: 0,
    });
    expect(contractorTables.contractors).toHaveLength(1);
  });

  it("allows two contractors with the same name", async () => {
    expect((await asAdmin("post", "", "en", body)).status).toBe(201);
    expect((await asAdmin("post", "", "en", body)).status).toBe(201);
    expect(contractorTables.contractors).toHaveLength(2);
  });

  it("writes an audit row in the same transaction", async () => {
    const res = await asAdmin("post", "", "en", body);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "contractor.create",
      entity: "Contractor",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: { name: "Nile Builders", phone: "0100 123 4567" },
      requestId: expect.any(String),
    });
    expect(auditRows()[0]).not.toHaveProperty("before");
  });

  it("rolls the contractor back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("post", "", "en", body);

    expect(res.status).toBe(500);
    expect(contractorTables.contractors).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it.each([
    ["no body", {}],
    ["a missing name", { phone: "0100 123 4567" }],
    ["a missing phone", { name: "Nile" }],
    ["a blank name", { name: "   ", phone: "0100 123 4567" }],
    ["a 101-character name", { name: "x".repeat(101), phone: "0100 123 4567" }],
    ["a phone that is too short", { name: "Nile", phone: "1234" }],
    ["a phone that is too long", { name: "Nile", phone: "1".repeat(21) }],
    ["a phone with letters", { name: "Nile", phone: "0100 abc 4567" }],
    ["a phone that is not a string", { name: "Nile", phone: 1001234567 }],
    ["an unknown field", { ...body, villaCount: 5 }],
    ["an id", { ...body, id: MISSING_ID }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await asAdmin("post", "", "en", payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(contractorTables.contractors).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("explains each problem in Arabic, once per field", async () => {
    const res = await asAdmin("post", "", "ar", { name: " ", phone: "12" });

    expect(res.body.message).toBe("فشل التحقق");
    expect(res.body.details).toEqual([
      { path: "name", message: "الاسم مطلوب" },
      {
        path: "phone",
        message:
          "أدخل رقم هاتف صالحًا: من 5 إلى 20 حرفًا، أرقام مع علامة + اختيارية في البداية ومسافات أو شرطات",
      },
    ]);
  });
});

describe("PATCH /contractors/:id", () => {
  it("updates the name, the phone, or both, and audits before and after", async () => {
    const con = addContractor({ name: "Old Name", phone: "0100 111 2222" });

    const both = await asAdmin("patch", `/${con.id}`, "en", { name: " New Name ", phone: "0100 999 8888" });
    const nameOnly = await asAdmin("patch", `/${con.id}`, "en", { name: "Newer Name" });
    const phoneOnly = await asAdmin("patch", `/${con.id}`, "en", { phone: "0100 000 1111" });

    expect(both.body.data).toMatchObject({ name: "New Name", phone: "0100 999 8888" });
    expect(nameOnly.body.data).toMatchObject({ name: "Newer Name", phone: "0100 999 8888" });
    expect(phoneOnly.body.data).toMatchObject({ name: "Newer Name", phone: "0100 000 1111" });
    expect(auditRows()[0]).toMatchObject({
      action: "contractor.update",
      entity: "Contractor",
      actorId: admin.id,
      entityId: con.id,
      before: { name: "Old Name", phone: "0100 111 2222" },
      after: { name: "New Name", phone: "0100 999 8888" },
    });
  });

  it("returns villaCount with the updated contractor", async () => {
    const con = addContractor({ name: "Busy" });
    linkVilla(con.id, addVilla().id);
    linkVilla(con.id, addVilla().id);

    expect((await asAdmin("patch", `/${con.id}`, "en", { name: "Still Busy" })).body.data.villaCount).toBe(2);
  });

  it.each([
    ["an empty body", {}],
    ["an unknown field", { name: "N", villaCount: 9 }],
    ["a blank name", { name: " " }],
    ["a bad phone", { phone: "abc" }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const con = addContractor({ name: "Keep", phone: "0100 111 2222" });

    const res = await asAdmin("patch", `/${con.id}`, "en", payload);

    expect(res.status).toBe(400);
    expect(contractorTables.contractors[0]).toMatchObject({ name: "Keep", phone: "0100 111 2222" });
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 for an unknown contractor, and 400 for a malformed id", async () => {
    expect((await asAdmin("patch", `/${MISSING_ID}`, "en", { name: "N" })).status).toBe(404);
    expect((await asAdmin("patch", "/nope", "en", { name: "N" })).status).toBe(400);
  });

  it("answers 404 when the contractor is deleted by someone else mid-request (P2025)", async () => {
    const con = addContractor({ name: "Gone Soon" });
    contractorTables.removeBeforeWrite = true;

    const res = await asAdmin("patch", `/${con.id}`, "ar", { name: "Too Late" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the change back when the audit write fails", async () => {
    const con = addContractor({ name: "Keep", phone: "0100 111 2222" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("patch", `/${con.id}`, "en", { name: "Changed" });

    expect(res.status).toBe(500);
    expect(contractorTables.contractors[0]).toMatchObject({ name: "Keep", phone: "0100 111 2222" });
  });
});

describe("DELETE /contractors/:id", () => {
  it("deletes with 204 and no body, and audits the deleted values", async () => {
    const con = addContractor({ name: "Nile Builders", phone: "0100 123 4567" });

    const res = await asAdmin("delete", `/${con.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(contractorTables.contractors).toHaveLength(0);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "contractor.delete",
      entity: "Contractor",
      actorId: admin.id,
      entityId: con.id,
      before: { name: "Nile Builders", phone: "0100 123 4567" },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("is blocked with 409 CONTRACTOR_HAS_VILLAS while a villa is linked, in Arabic on request", async () => {
    const con = addContractor({ name: "Busy" });
    linkVilla(con.id, addVilla().id);

    const res = await asAdmin("delete", `/${con.id}`, "ar");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "CONTRACTOR_HAS_VILLAS",
      message: "هذا المقاول مرتبط بفلل أو بسجلات ولا يمكن حذفه",
    });
    expect(contractorTables.contractors).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("is blocked with 409 CONTRACTOR_HAS_VILLAS, translated, while a daily labour row names it, though no villa is linked: the foreign key is the guard", async () => {
    const named = addContractor({ name: "On labour" });
    const free = addContractor({ name: "Free" });
    const now = new Date();
    dailyLabourTables.rows.push({
      id: randomUUID(),
      villaId: randomUUID(),
      labourDate: new Date("2026-03-04T00:00:00.000Z"),
      contractorId: named.id,
      labourCount: 3,
      notes: null,
      createdById: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const arabic = await asAdmin("delete", `/${named.id}`, "ar");
    const english = await asAdmin("delete", `/${named.id}`);

    expect(arabic.status).toBe(409);
    expect(arabic.body).toMatchObject({
      code: "CONTRACTOR_HAS_VILLAS",
      message: "هذا المقاول مرتبط بفلل أو بسجلات ولا يمكن حذفه",
    });
    expect(english.body.message).toBe("This contractor is linked to villas or records and cannot be deleted");
    expect(contractorTables.contractors.map((c) => c.id)).toContain(named.id);
    expect(auditRows()).toHaveLength(0);
    expect((await asAdmin("delete", `/${free.id}`)).status).toBe(204);
  });

  it("only blocks the contractor that has villas", async () => {
    const busy = addContractor({ name: "Busy" });
    const free = addContractor({ name: "Free" });
    linkVilla(busy.id, addVilla().id);

    expect((await asAdmin("delete", `/${free.id}`)).status).toBe(204);
    expect((await asAdmin("delete", `/${busy.id}`)).status).toBe(409);
  });

  it("answers 404 for an unknown contractor, and 400 for a malformed id", async () => {
    expect((await asAdmin("delete", `/${MISSING_ID}`, "ar")).body.code).toBe("CONTRACTOR_NOT_FOUND");
    expect((await asAdmin("delete", "/nope")).status).toBe(400);
  });

  it("answers 409 when a villa is linked after the check but before the delete (foreign key, P2003)", async () => {
    const con = addContractor({ name: "Race" });
    contractorTables.linkVillaBeforeDelete = true;

    const res = await asAdmin("delete", `/${con.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONTRACTOR_HAS_VILLAS");
    expect(contractorTables.contractors).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 when another request deletes it first (P2025)", async () => {
    const con = addContractor({ name: "Raced Away" });
    contractorTables.removeBeforeWrite = true;

    const res = await asAdmin("delete", `/${con.id}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the delete back when the audit write fails", async () => {
    const con = addContractor({ name: "Keep Me" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("delete", `/${con.id}`);

    expect(res.status).toBe(500);
    expect(contractorTables.contractors).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("records create, update and delete in order, each with the actor and a request id", async () => {
    const created = await asAdmin("post", "", "en", { name: "Nile", phone: "0100 123 4567" });
    const id = created.body.data.id as string;
    await asAdmin("patch", `/${id}`, "en", { phone: "0100 999 8888" });
    await asAdmin("delete", `/${id}`);

    expect(auditRows().map((row) => row["action"])).toEqual([
      "contractor.create",
      "contractor.update",
      "contractor.delete",
    ]);
    for (const row of auditRows()) {
      expect(row).toMatchObject({ actorId: admin.id, entity: "Contractor", entityId: id });
      expect(row["requestId"]).toEqual(expect.any(String));
    }
  });
});

describe("email and status", () => {
  const body = { name: "Mona Hassan", phone: "0100 123 4567" };
  const detailsOf = (res: request.Response): { path: string; message: string }[] => res.body.details;

  it("create: with neither, the email is null and the status ACTIVE; the response and the row say so", async () => {
    const res = await asAdmin("post", "", "en", body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: null, status: "ACTIVE" });
    expect(contractorTables.contractors[0]).toMatchObject({ email: null, status: "ACTIVE" });
    expect(auditRows()[0]).toMatchObject({ after: { email: null, status: "ACTIVE" } });
  });

  it("create: trims and lowercases the email, keeps the status, and audits both", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body,
      email: "  Mona.Hassan@Example.TEST ",
      status: "INACTIVE",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: "mona.hassan@example.test", status: "INACTIVE" });
    expect(contractorTables.contractors[0]).toMatchObject({
      email: "mona.hassan@example.test",
      status: "INACTIVE",
    });
    expect(auditRows()[0]).toMatchObject({
      action: "contractor.create",
      after: {
        name: "Mona Hassan",
        phone: "0100 123 4567",
        email: "mona.hassan@example.test",
        status: "INACTIVE",
      },
    });
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["null", null],
  ])("create: a %s email means none", async (_label, email) => {
    const res = await asAdmin("post", "", "en", { ...body, email });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBeNull();
    expect(contractorTables.contractors[0]?.email).toBeNull();
  });

  it("create: two records may share an email", async () => {
    const first = await asAdmin("post", "", "en", { ...body, email: "shared@example.test" });
    const second = await asAdmin("post", "", "en", { ...body, email: "SHARED@example.test" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(contractorTables.contractors.map((r) => r.email)).toEqual([
      "shared@example.test",
      "shared@example.test",
    ]);
  });

  it.each([
    { label: "no @", email: "not-an-email" },
    { label: "no domain suffix", email: "a@b" },
    { label: "two @", email: "two@@example.test" },
    { label: "a space", email: "spaces in@example.test" },
    { label: "over 254 characters", email: `${"x".repeat(250)}@e.test` },
  ])(
    "create: refuses an email with $label with 400, creates nothing, and explains it in Arabic",
    async ({ email }) => {
      const res = await asAdmin("post", "", "ar", { ...body, email });

      expect(res.status).toBe(400);
      expect(detailsOf(res)).toHaveLength(1);
      expect(detailsOf(res)[0]).toMatchObject({ path: "email" });
      expect(contractorTables.contractors).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("create: says why in each language", async () => {
    const en = await asAdmin("post", "", "en", { ...body, email: "nope" });
    const ar = await asAdmin("post", "", "ar", { ...body, email: "nope" });

    expect(detailsOf(en)[0]?.message).toBe("Enter a valid email address");
    expect(detailsOf(ar)[0]?.message).toBe("أدخل بريدًا إلكترونيًا صالحًا");
  });

  it.each(["active", "PAUSED", "", null, 1])("create: refuses the status %j with 400", async (status) => {
    const res = await asAdmin("post", "", "en", { ...body, status });

    expect(res.status).toBe(400);
    expect(detailsOf(res)[0]).toMatchObject({ path: "status", message: "Status must be ACTIVE or INACTIVE" });
    expect(contractorTables.contractors).toHaveLength(0);
  });

  it("create: says the status is wrong in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { ...body, status: "PAUSED" });

    expect(detailsOf(res)[0]?.message).toBe("يجب أن تكون الحالة ACTIVE أو INACTIVE");
  });

  it("update: sets the email, changes the status, and audits before and after", async () => {
    const rec = addContractor({ name: "Keep", phone: "0100 111 2222" });

    const res = await asAdmin("patch", `/${rec.id}`, "en", {
      email: " Keep@Example.test ",
      status: "INACTIVE",
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: "Keep",
      phone: "0100 111 2222",
      email: "keep@example.test",
      status: "INACTIVE",
    });
    expect(auditRows()[0]).toMatchObject({
      action: "contractor.update",
      before: { name: "Keep", phone: "0100 111 2222", email: null, status: "ACTIVE" },
      after: { name: "Keep", phone: "0100 111 2222", email: "keep@example.test", status: "INACTIVE" },
    });
  });

  it.each([
    ["null", null],
    ["blank", "  "],
  ])("update: a %s email clears it and leaves the rest alone", async (_label, email) => {
    const rec = addContractor({ name: "Keep", email: "old@example.test", status: "INACTIVE" });

    const res = await asAdmin("patch", `/${rec.id}`, "en", { email });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Keep", email: null, status: "INACTIVE" });
    expect(auditRows()[0]).toMatchObject({
      before: { email: "old@example.test", status: "INACTIVE" },
      after: { email: null, status: "INACTIVE" },
    });
  });

  it("update: an email or a status alone is a valid update; a name alone leaves them untouched", async () => {
    const rec = addContractor({ name: "Keep", email: "keep@example.test", status: "INACTIVE" });

    const nameOnly = await asAdmin("patch", `/${rec.id}`, "en", { name: "Renamed" });
    const statusOnly = await asAdmin("patch", `/${rec.id}`, "en", { status: "ACTIVE" });

    expect(nameOnly.body.data).toMatchObject({
      name: "Renamed",
      email: "keep@example.test",
      status: "INACTIVE",
    });
    expect(statusOnly.body.data).toMatchObject({
      name: "Renamed",
      email: "keep@example.test",
      status: "ACTIVE",
    });
  });

  it("update: refuses a malformed email or an unknown status with 400 and changes nothing", async () => {
    const rec = addContractor({ name: "Keep", email: "keep@example.test" });

    const badEmail = await asAdmin("patch", `/${rec.id}`, "en", { email: "nope" });
    const badStatus = await asAdmin("patch", `/${rec.id}`, "en", { status: "PAUSED" });

    expect(badEmail.status).toBe(400);
    expect(badStatus.status).toBe(400);
    expect(contractorTables.contractors[0]).toMatchObject({
      email: "keep@example.test",
      status: "ACTIVE",
      version: 1,
    });
    expect(auditRows()).toHaveLength(0);
  });

  it("update: bumps the version, and a stale version is still refused", async () => {
    const rec = addContractor({ name: "Keep" });

    const first = await asAdmin("patch", `/${rec.id}`, "en", { status: "INACTIVE" });
    const stale = await call("patch", `/${rec.id}`)
      .set(await as(admin))
      .set("If-Match", "1")
      .send({ status: "ACTIVE" });

    expect(first.body.data.version).toBe(2);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect(contractorTables.contractors[0]?.status).toBe("INACTIVE");
  });

  it("get: one record carries its email and status", async () => {
    const rec = addContractor({ name: "Keep", email: "keep@example.test", status: "INACTIVE" });

    const res = await asAdmin("get", `/${rec.id}`);

    expect(res.body.data).toMatchObject({ email: "keep@example.test", status: "INACTIVE" });
  });

  describe("list", () => {
    beforeEach(() => {
      addContractor({ name: "Alice Nour", phone: "0100 111 2222", email: "alice@acme.test" });
      addContractor({
        name: "Bob Adel",
        phone: "0101 333 4444",
        email: "bob@other.test",
        status: "INACTIVE",
      });
      addContractor({ name: "Carol Samir", phone: "0102 555 6666", status: "INACTIVE" });
      addContractor({ name: "Dina Fouad", phone: "0103 777 8888", email: "dina@acme.test" });
    });

    it("shows every record by default, active and inactive, with their email and status", async () => {
      const res = await asAdmin("get", "");

      expect(names(res)).toEqual(["Alice Nour", "Bob Adel", "Carol Samir", "Dina Fouad"]);
      expect(res.body.data.map((i: { status: string }) => i.status)).toEqual([
        "ACTIVE",
        "INACTIVE",
        "INACTIVE",
        "ACTIVE",
      ]);
      expect(res.body.data.map((i: { email: string | null }) => i.email)).toEqual([
        "alice@acme.test",
        "bob@other.test",
        null,
        "dina@acme.test",
      ]);
    });

    it("filters by status and counts only the matches in the meta", async () => {
      const inactive = await asAdmin("get", "?status=INACTIVE");
      const active = await asAdmin("get", "?status=ACTIVE");

      expect(names(inactive)).toEqual(["Bob Adel", "Carol Samir"]);
      expect(inactive.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(names(active)).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(active.body.meta.total).toBe(2);
    });

    it("searches the email as well as the name and the phone, case-insensitively", async () => {
      expect(names(await asAdmin("get", "?search=ACME"))).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(names(await asAdmin("get", "?search=bob@other"))).toEqual(["Bob Adel"]);
      expect(names(await asAdmin("get", "?search=nour"))).toEqual(["Alice Nour"]);
      expect(names(await asAdmin("get", "?search=0102"))).toEqual(["Carol Samir"]);
    });

    it("combines the status filter with the search, and with paging", async () => {
      expect(names(await asAdmin("get", "?status=ACTIVE&search=acme"))).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(names(await asAdmin("get", "?status=INACTIVE&search=acme"))).toEqual([]);
      const paged = await asAdmin("get", "?status=INACTIVE&limit=1&page=2");
      expect(names(paged)).toEqual(["Carol Samir"]);
      expect(paged.body.meta).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    });

    it.each(["active", "PAUSED", "OPEN", ""])(
      "rejects status=%j with 400, in Arabic on request",
      async (value) => {
        const res = await asAdmin("get", `?status=${value}`, "ar");

        expect(res.status).toBe(400);
        expect(detailsOf(res)[0]).toMatchObject({
          path: "status",
          message: "يجب أن تكون الحالة ACTIVE أو INACTIVE",
        });
      },
    );
  });

  describe("options", () => {
    it("leaves out the inactive records, and brings one back when it is reactivated", async () => {
      const amy = addContractor({ name: "Amy" });
      const bea = addContractor({ name: "Bea", status: "INACTIVE" });
      const cal = addContractor({ name: "Cal" });

      const before = await asAdmin("get", "/options");
      await asAdmin("patch", `/${bea.id}`, "en", { status: "ACTIVE" });
      await asAdmin("patch", `/${amy.id}`, "en", { status: "INACTIVE" });
      const after = await asAdmin("get", "/options");

      expect(before.body.data).toEqual([
        { id: amy.id, name: "Amy" },
        { id: cal.id, name: "Cal" },
      ]);
      expect(after.body.data).toEqual([
        { id: bea.id, name: "Bea" },
        { id: cal.id, name: "Cal" },
      ]);
      expect(JSON.stringify(before.body)).not.toMatch(/email|status/);
    });

    it("is empty when every record is inactive", async () => {
      addContractor({ name: "Amy", status: "INACTIVE" });

      expect((await asAdmin("get", "/options")).body.data).toEqual([]);
    });
  });

  it("an inactive record can still be read, updated and deleted", async () => {
    const rec = addContractor({ name: "Old", status: "INACTIVE" });

    const read = await asAdmin("get", `/${rec.id}`);
    const renamed = await asAdmin("patch", `/${rec.id}`, "en", { name: "Older" });
    const removed = await asAdmin("delete", `/${rec.id}`);

    expect(read.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: "Older", status: "INACTIVE" });
    expect(removed.status).toBe(204);
  });

  it("permissions are unchanged: reading needs read, writing the new fields needs update", async () => {
    const rec = addContractor({ name: "Keep" });

    const reader = await call("get", `/${rec.id}`).set(
      await as(employee("r@example.test", "contractors:read")),
    );
    const readerPatch = await call("patch", `/${rec.id}`)
      .set(await as(employee("r2@example.test", "contractors:read")))
      .send({ status: "INACTIVE" });
    const updater = await call("patch", `/${rec.id}`)
      .set(await as(employee("u@example.test", "contractors:update")))
      .send({ email: "u@example.test" });

    expect(reader.status).toBe(200);
    expect(reader.body.data).toMatchObject({ email: null, status: "ACTIVE" });
    expect(readerPatch.status).toBe(403);
    expect(updater.status).toBe(200);
  });
});

// A contractor's villa count comes from the villas table, so a villa can be linked without the contractor's version moving.
// The ETag must not let a client reuse the old body.
describe("a contractor after a villa is linked to it", () => {
  it("is answered 200 with the new villa count to a request with the old ETag, never 304", async () => {
    const contractor = addContractor({ name: "Nile Builders" });
    const before = await asAdmin("get", `/${contractor.id}`);
    expect(before.body.data).toMatchObject({ villaCount: 0, version: 1 });

    linkVilla(contractor.id, addVilla().id);
    const after = await call("get", `/${contractor.id}`)
      .set(await as(admin))
      .set("If-None-Match", before.headers["etag"] as string);

    expect(after.status).toBe(200);
    expect(after.body.data.villaCount).toBe(1);
  });

  it("still carries the ETag and the version, and is not cacheable", async () => {
    const contractor = addContractor({ name: "Nile Builders" });

    const res = await asAdmin("get", `/${contractor.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe(`"${res.body.data.version}"`);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
