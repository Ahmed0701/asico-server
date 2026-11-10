import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { MAX_OPTIONS } from "../../../src/modules/areas/dto/areas.dto.js";
import type { AreaRow, AreasRepository, Db } from "../../../src/modules/areas/repository/areas.repository.js";
import { AreasService } from "../../../src/modules/areas/service/areas.service.js";
import {
  createAreaSchema,
  listAreasQuerySchema,
  updateAreaSchema,
  type ListAreasQuery,
} from "../../../src/modules/areas/validators/areas.validators.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const actor: Actor = { id: "admin-1", role: "ADMIN" };
const tx = { marker: "tx" } as unknown as Db;
const CREATED = new Date("2026-03-04T05:06:07.890Z");
const UPDATED = new Date("2026-03-05T05:06:07.890Z");

function row(overrides: Partial<AreaRow> = {}, villas = 0): AreaRow {
  return {
    id: "area-1",
    name: "New Cairo",
    city: "Cairo",
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    _count: { villas: villas },
    ...overrides,
  };
}

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    list: vi.fn(),
    options: vi.fn(),
    findById: vi.fn(),
    findByNameAndCity: vi.fn(),
    lockVersion: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    countVillas: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let service: AreasService;
const auditCalls = () => vi.mocked(audit.record).mock.calls;
const auditEntry = (index = 0) => auditCalls()[index]?.[1];
const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

beforeEach(() => {
  vi.mocked(audit.record).mockReset();
  repo = makeRepo();
  repo.lockVersion.mockResolvedValue(1);
  repo.delete.mockResolvedValue(true);
  repo.countVillas.mockResolvedValue(0);
  repo.findByNameAndCity.mockResolvedValue(null);
  service = new AreasService(repo as unknown as AreasRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListAreasQuery> = {}): ListAreasQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("defaults to name ascending, page 1, 20 per page, and maps rows to DTOs with the derived villa count", async () => {
    repo.list.mockResolvedValue({ rows: [row({}, 3), row({ id: "area-2" })], total: 45 });

    const result = await service.list(query());

    expect(repo.list).toHaveBeenCalledWith({
      search: undefined,
      sort: { field: "name", direction: "asc" },
      skip: 0,
      take: 20,
    });
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.items[0]).toEqual({
      id: "area-1",
      name: "New Cairo",
      city: "Cairo",
      villaCount: 3,
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-05T05:06:07.890Z",
    });
    expect(result.items[1]).toMatchObject({ villaCount: 0 });
  });

  it("passes the search and the page window through", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ search: "cairo", page: 3, limit: 50 }));

    expect(repo.list).toHaveBeenCalledWith({
      search: "cairo",
      sort: { field: "name", direction: "asc" },
      skip: 100,
      take: 50,
    });
  });

  it.each([
    ["name", "name", "asc"],
    ["name:desc", "name", "desc"],
    ["city", "city", "asc"],
    ["city:desc", "city", "desc"],
    ["villaCount", "villaCount", "asc"],
    ["villaCount:desc", "villaCount", "desc"],
    ["createdAt:asc", "createdAt", "asc"],
    ["createdAt:desc", "createdAt", "desc"],
  ])("sorts by %s", async (sort, field, direction) => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ sort }));

    expect(repo.list.mock.calls[0]?.[0]).toMatchObject({ sort: { field, direction } });
  });

  it("falls back to name ascending for a sort it does not know", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ sort: "villas" }));

    expect(repo.list.mock.calls[0]?.[0]).toMatchObject({ sort: { field: "name", direction: "asc" } });
  });

  it("reports an empty table as a single empty page, like every other list", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    expect((await service.list(query())).meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });
});

describe("options", () => {
  it("returns id, name and city only", async () => {
    repo.options.mockResolvedValue([{ id: "a1", name: "New Cairo", city: "Cairo", extra: "must not leak" }]);

    expect(await service.options()).toEqual([{ id: "a1", name: "New Cairo", city: "Cairo" }]);
  });

  it("is capped at a bounded number of entries", () => {
    expect(MAX_OPTIONS).toBe(1000);
  });
});

describe("get", () => {
  it("returns the area with its villa count", async () => {
    repo.findById.mockResolvedValue(row({ version: 4 }, 12));

    await expect(service.get("area-1", ctx)).resolves.toMatchObject({
      id: "area-1",
      version: 4,
      villaCount: 12,
    });
  });

  it("answers 404 AREA_NOT_FOUND, translated", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.get("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
      message: "المنطقة غير موجودة",
    });
  });
});

describe("create", () => {
  const input = { name: "New Cairo", city: "Cairo" };

  beforeEach(() => {
    repo.create.mockResolvedValue(row({ id: "new-area" }));
  });

  it("checks the name within the city and creates the area, in one transaction", async () => {
    const dto = await service.create(actor, input, ctx);

    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(repo.findByNameAndCity).toHaveBeenCalledWith("New Cairo", "Cairo", tx);
    expect(repo.create).toHaveBeenCalledWith({ name: "New Cairo", city: "Cairo" }, tx);
    expect(dto).toMatchObject({
      id: "new-area",
      name: "New Cairo",
      city: "Cairo",
      villaCount: 0,
      version: 1,
    });
  });

  it("audits area.create with the new name and city only, never the derived count, in the same transaction", async () => {
    await service.create(actor, input, ctx);

    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "area.create",
      entity: "Area",
      actorId: "admin-1",
      entityId: "new-area",
      after: { name: "New Cairo", city: "Cairo" },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
    expect(auditEntry()).not.toHaveProperty("before", expect.anything());
    expect(JSON.stringify(auditEntry()?.after)).not.toMatch(/villa|count/i);
  });

  it("answers 409 AREA_TAKEN when the name is in use in that city, with a detail on the name, translated", async () => {
    repo.findByNameAndCity.mockResolvedValue({ id: "other" });

    const err = await failure(service.create(actor, input, ctxAr));

    expect(err).toMatchObject({
      statusCode: 409,
      code: "AREA_TAKEN",
      message: "توجد منطقة بهذا الاسم بالفعل في هذه المدينة",
    });
    expect(err.details).toEqual([{ path: "name", message: "توجد منطقة بهذا الاسم بالفعل في هذه المدينة" }]);
    expect(repo.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 AREA_TAKEN when the unique index catches a race", async () => {
    repo.create.mockRejectedValue(prismaError("P2002"));

    expect(await failure(service.create(actor, input, ctx))).toMatchObject({
      statusCode: 409,
      code: "AREA_TAKEN",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("ignores any field it was not meant to take", async () => {
    await service.create(actor, { ...input, id: "chosen", version: 9, villaCount: 5 } as never, ctx);

    expect(repo.create).toHaveBeenCalledWith({ name: "New Cairo", city: "Cairo" }, tx);
  });

  it("lets other errors through unchanged", async () => {
    repo.create.mockRejectedValue(new Error("connection lost"));

    await expect(service.create(actor, input, ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.create(actor, input, ctx)).rejects.toThrow("audit down");
  });
});

describe("update", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row({}, 4));
    repo.update.mockImplementation(async (_id: string, _version: number, data: Partial<AreaRow>) =>
      row({ ...data, version: 2 }, 4),
    );
  });

  it("answers 404 for an unknown area and writes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.update(actor, "x", { name: "N" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
      message: "المنطقة غير موجودة",
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("sends only the fields that were given, with the version it read, and returns the new row", async () => {
    const dto = await service.update(actor, "area-1", { city: "Giza" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("area-1", 1, { city: "Giza" }, tx);
    expect(dto).toMatchObject({ id: "area-1", city: "Giza", name: "New Cairo", version: 2, villaCount: 4 });
  });

  it("checks uniqueness against the name and city the area will have afterwards", async () => {
    await service.update(actor, "area-1", { name: "Palm Hills" }, ctx);
    await service.update(actor, "area-1", { city: "Giza" }, ctx);
    await service.update(actor, "area-1", { name: "Zed", city: "Alex" }, ctx);

    expect(repo.findByNameAndCity.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["Palm Hills", "Cairo"],
      ["New Cairo", "Giza"],
      ["Zed", "Alex"],
    ]);
  });

  it("lets an area keep its own name and city, but not take another area's", async () => {
    repo.findByNameAndCity.mockResolvedValueOnce({ id: "area-1" });
    await expect(service.update(actor, "area-1", { name: "New Cairo" }, ctx)).resolves.toBeDefined();

    repo.findByNameAndCity.mockResolvedValueOnce({ id: "area-2" });
    expect(await failure(service.update(actor, "area-1", { name: "Palm Hills" }, ctxAr))).toMatchObject({
      statusCode: 409,
      code: "AREA_TAKEN",
    });
  });

  it("answers 409 AREA_TAKEN when the unique index catches a race", async () => {
    repo.update.mockRejectedValue(prismaError("P2002"));

    expect(await failure(service.update(actor, "area-1", { name: "N" }, ctx))).toMatchObject({
      statusCode: 409,
      code: "AREA_TAKEN",
    });
  });

  it("audits only the name and city, before and after, in the same transaction", async () => {
    await service.update(actor, "area-1", { name: "Palm Hills", city: "Giza" }, ctx);

    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "area.update",
      entity: "Area",
      actorId: "admin-1",
      entityId: "area-1",
      before: { name: "New Cairo", city: "Cairo" },
      after: { name: "Palm Hills", city: "Giza" },
      requestId: "req-1",
    });
    expect(JSON.stringify(auditEntry())).not.toMatch(/villaCount/);
  });

  it("locks and reads the row, in that order, before it writes", async () => {
    const order: string[] = [];
    repo.lockVersion.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    repo.findById.mockImplementation(async () => {
      order.push("read");
      return row();
    });

    await service.update(actor, "area-1", { name: "N" }, ctx);

    expect(order).toEqual(["lock", "read"]);
  });

  it("answers 404 when the area is deleted between the lookup and the write", async () => {
    repo.update.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.update(actor, "area-1", { name: "N" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
    });
  });

  it("lets other errors through unchanged, and fails as a whole when the audit write fails", async () => {
    repo.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(service.update(actor, "area-1", { name: "N" }, ctx)).rejects.toThrow("connection lost");

    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));
    await expect(service.update(actor, "area-1", { name: "N" }, ctx)).rejects.toThrow("audit down");
  });

  describe("version", () => {
    it("refuses an If-Match that is not the current version: 409 with the current version, nothing written", async () => {
      repo.lockVersion.mockResolvedValue(4);

      const err = await failure(service.update(actor, "area-1", { name: "N" }, ctxAr, 3));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ path: "version", value: 4 })]);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("accepts an If-Match that equals the current version", async () => {
      repo.lockVersion.mockResolvedValue(4);
      repo.findById.mockResolvedValue(row({ version: 4 }));

      await service.update(actor, "area-1", { name: "N" }, ctx, 4);

      expect(repo.update.mock.calls[0]?.slice(0, 3)).toEqual(["area-1", 4, { name: "N" }]);
    });

    it("does not insist on a version when the caller sent none", async () => {
      repo.lockVersion.mockResolvedValue(9);
      repo.findById.mockResolvedValue(row({ version: 9 }));

      await expect(service.update(actor, "area-1", { name: "N" }, ctx)).resolves.toBeDefined();
    });

    it("answers 409 with the version it finds now when it loses the race for the row", async () => {
      repo.update.mockResolvedValue(null);
      repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const err = await failure(service.update(actor, "area-1", { name: "N" }, ctx));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ value: 2 })]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("answers 404, not a conflict, for an id that does not exist even with a stale If-Match", async () => {
      repo.lockVersion.mockResolvedValue(null);

      expect(await failure(service.update(actor, "x", { name: "N" }, ctx, 1))).toMatchObject({
        statusCode: 404,
      });
    });
  });
});

describe("remove", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
  });

  it("answers 404 for an unknown area and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.remove(actor, "x", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
    });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes an area with no villas inside a transaction, and audits its name and city", async () => {
    await service.remove(actor, "area-1", ctx);

    expect(repo.countVillas).toHaveBeenCalledWith("area-1", tx);
    expect(repo.delete).toHaveBeenCalledWith("area-1", 1, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "area.delete",
      entity: "Area",
      actorId: "admin-1",
      entityId: "area-1",
      before: { name: "New Cairo", city: "Cairo" },
    });
    expect(auditEntry()).not.toHaveProperty("after", expect.anything());
  });

  it.each([1, 7])(
    "refuses with 409 AREA_HAS_VILLAS while %i villas are in it, and changes nothing",
    async (villas) => {
      repo.countVillas.mockResolvedValue(villas);

      const err = await failure(service.remove(actor, "area-1", ctxAr));

      expect(err).toMatchObject({
        statusCode: 409,
        code: "AREA_HAS_VILLAS",
        message: "هذه المنطقة بها فلل ولا يمكن حذفها",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("answers 409 AREA_HAS_VILLAS too when a villa is added after the count and the foreign key refuses the delete", async () => {
    repo.delete.mockRejectedValue(prismaError("P2003"));

    expect(await failure(service.remove(actor, "area-1", ctx))).toMatchObject({
      statusCode: 409,
      code: "AREA_HAS_VILLAS",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("maps P2025 (already deleted) to 404", async () => {
    repo.delete.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.remove(actor, "area-1", ctx))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
    });
  });

  it("refuses a stale If-Match with 409 VERSION_CONFLICT and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(5);

    const err = await failure(service.remove(actor, "area-1", ctx, 4));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(err.details).toEqual([expect.objectContaining({ value: 5 })]);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("answers 409 when the row changed after it was read (compare-and-set lost)", async () => {
    repo.delete.mockResolvedValue(false);
    repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await failure(service.remove(actor, "area-1", ctx))).toMatchObject({
      statusCode: 409,
      code: "VERSION_CONFLICT",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("lets other errors through, and fails as a whole when the audit write fails", async () => {
    repo.delete.mockRejectedValueOnce(new Error("connection lost"));
    await expect(service.remove(actor, "area-1", ctx)).rejects.toThrow("connection lost");

    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));
    await expect(service.remove(actor, "area-1", ctx)).rejects.toThrow("audit down");
  });
});

describe("request validation", () => {
  const issues = (result: {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  }) =>
    result.success
      ? []
      : (result.error?.issues ?? []).map((i) => ({ path: i.path.join("."), message: i.message }));

  describe("create", () => {
    it("takes a name and a city, trimmed", () => {
      expect(createAreaSchema.parse({ name: "  New Cairo ", city: " Cairo  " })).toEqual({
        name: "New Cairo",
        city: "Cairo",
      });
    });

    it("requires both", () => {
      expect(issues(createAreaSchema.safeParse({}))).toEqual([
        { path: "name", message: "validation.required" },
        { path: "city", message: "validation.required" },
      ]);
    });

    it("refuses a blank name or city with the field's own message", () => {
      expect(issues(createAreaSchema.safeParse({ name: "  ", city: "Cairo" }))).toEqual([
        { path: "name", message: "validation.nameRequired" },
      ]);
      expect(issues(createAreaSchema.safeParse({ name: "New Cairo", city: "  " }))).toEqual([
        { path: "city", message: "validation.cityRequired" },
      ]);
    });

    it("accepts a city of 100 characters and refuses 101", () => {
      expect(createAreaSchema.safeParse({ name: "N", city: "c".repeat(100) }).success).toBe(true);
      expect(issues(createAreaSchema.safeParse({ name: "N", city: "c".repeat(101) }))).toEqual([
        { path: "city", message: "validation.cityTooLong" },
      ]);
    });

    it("refuses anything a client must not set: the count, the id, the version", () => {
      for (const extra of [{ villaCount: 3 }, { id: "x" }, { version: 2 }, { createdAt: "2026-01-01" }]) {
        expect(createAreaSchema.safeParse({ name: "N", city: "C", ...extra }).success).toBe(false);
      }
    });
  });

  describe("update", () => {
    it("needs at least one field", () => {
      expect(issues(updateAreaSchema.safeParse({}))).toEqual([
        { path: "", message: "validation.atLeastOneField" },
      ]);
    });

    it("accepts either field alone, and never adds the other", () => {
      const name = updateAreaSchema.safeParse({ name: "N" });
      const city = updateAreaSchema.safeParse({ city: "C" });
      expect(name.success && Object.keys(name.data)).toEqual(["name"]);
      expect(city.success && Object.keys(city.data)).toEqual(["city"]);
    });

    it("applies the same limits as create, and refuses a derived count", () => {
      expect(issues(updateAreaSchema.safeParse({ city: "c".repeat(101) }))).toEqual([
        { path: "city", message: "validation.cityTooLong" },
      ]);
      expect(updateAreaSchema.safeParse({ villaCount: 3 }).success).toBe(false);
      expect(updateAreaSchema.safeParse({ name: "N", version: 3 }).success).toBe(false);
    });
  });

  describe("list query", () => {
    const parse = (input: Record<string, unknown>) => listAreasQuerySchema.safeParse(input);

    it("applies the shared pagination: limit 1000 ok, 1001 and non-numbers rejected", () => {
      expect(parse({ limit: "1000" }).success).toBe(true);
      expect(parse({ limit: "1001" }).success).toBe(false);
      expect(parse({ page: "0" }).success).toBe(false);
      expect(parse({ page: "abc" }).success).toBe(false);
    });

    it("accepts exactly the four sort fields, in either direction", () => {
      for (const field of ["name", "city", "villaCount", "createdAt"]) {
        expect(parse({ sort: field }).success).toBe(true);
        expect(parse({ sort: `${field}:desc` }).success).toBe(true);
      }
      for (const sort of ["id", "villas", "version:asc", "name:up", ":asc", "name:"]) {
        expect(issues(parse({ sort }))).toEqual([{ path: "sort", message: "validation.sortAreasInvalid" }]);
      }
    });

    it("trims the search and limits it to 100 characters", () => {
      expect(parse({ search: "  cairo " }).data?.search).toBe("cairo");
      expect(parse({ search: "x".repeat(100) }).success).toBe(true);
      expect(issues(parse({ search: "x".repeat(101) }))).toEqual([
        { path: "search", message: "validation.searchTooLong" },
      ]);
    });
  });
});
