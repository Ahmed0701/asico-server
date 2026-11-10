import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { MAX_OPTIONS } from "../../../src/modules/electrical-engineers/dto/electrical-engineers.dto.js";
import type {
  Db,
  ElectricalEngineerRow,
  ElectricalEngineersRepository,
} from "../../../src/modules/electrical-engineers/repository/electrical-engineers.repository.js";
import { ElectricalEngineersService } from "../../../src/modules/electrical-engineers/service/electrical-engineers.service.js";
import {
  createElectricalEngineerSchema,
  listElectricalEngineersQuerySchema,
  updateElectricalEngineerSchema,
  type ListElectricalEngineersQuery,
} from "../../../src/modules/electrical-engineers/validators/electrical-engineers.validators.js";

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

function row(
  overrides: Partial<ElectricalEngineerRow> = {},
  villas = 0,
  dailyReports = 0,
): ElectricalEngineerRow {
  return {
    id: "eng-1",
    name: "Omar Khaled",
    phone: "+20 100 123 4567",
    email: null,
    status: "ACTIVE",
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    _count: { villas, dailyReports },
    ...overrides,
  };
}

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    list: vi.fn(),
    options: vi.fn(),
    findById: vi.fn(),
    lockVersion: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let service: ElectricalEngineersService;
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
  service = new ElectricalEngineersService(repo as unknown as ElectricalEngineersRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListElectricalEngineersQuery> = {}): ListElectricalEngineersQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("defaults to name ascending, page 1, 20 per page, and maps rows to DTOs", async () => {
    repo.list.mockResolvedValue({ rows: [row({}, 3), row({ id: "eng-2" })], total: 45 });

    const result = await service.list(query());

    expect(repo.list).toHaveBeenCalledWith({
      search: undefined,
      status: undefined,
      sort: { field: "name", direction: "asc" },
      skip: 0,
      take: 20,
    });
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.items[0]).toEqual({
      id: "eng-1",
      name: "Omar Khaled",
      phone: "+20 100 123 4567",
      email: null,
      status: "ACTIVE",
      villaCount: 3,
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-05T05:06:07.890Z",
    });
    expect(result.items[1]?.villaCount).toBe(0);
  });

  it("passes the search and the page window through", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ search: "omar", page: 3, limit: 50 }));

    expect(repo.list).toHaveBeenCalledWith({
      search: "omar",
      status: undefined,
      sort: { field: "name", direction: "asc" },
      skip: 100,
      take: 50,
    });
  });

  it("passes the status filter through, with or without a search", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ status: "INACTIVE" }));
    await service.list(query({ status: "ACTIVE", search: "x@y.test" }));

    expect(repo.list.mock.calls[0]?.[0]).toMatchObject({ status: "INACTIVE", search: undefined });
    expect(repo.list.mock.calls[1]?.[0]).toMatchObject({ status: "ACTIVE", search: "x@y.test" });
  });

  it("shows the email and status of each record, null when there is no email", async () => {
    repo.list.mockResolvedValue({
      rows: [row({ email: "a@b.test", status: "INACTIVE" }), row({ id: "eng-2" })],
      total: 2,
    });

    const { items } = await service.list(query());

    expect(items[0]).toMatchObject({ email: "a@b.test", status: "INACTIVE" });
    expect(items[1]).toMatchObject({ email: null, status: "ACTIVE" });
  });

  it.each([
    ["name", "name", "asc"],
    ["name:desc", "name", "desc"],
    ["createdAt", "createdAt", "asc"],
    ["createdAt:asc", "createdAt", "asc"],
    ["createdAt:desc", "createdAt", "desc"],
    ["phone:desc", "name", "asc"],
  ])(
    "maps sort %j to %s %s, falling back to the default for anything off the whitelist",
    async (sort, field, direction) => {
      repo.list.mockResolvedValue({ rows: [], total: 0 });

      await service.list(query({ sort }));

      expect(repo.list.mock.calls[0]?.[0].sort).toEqual({ field, direction });
    },
  );

  it("reports one empty page when there is nothing", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    expect((await service.list(query())).meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });
});

describe("options", () => {
  it("returns only id and name", async () => {
    repo.options.mockResolvedValue([{ id: "1", name: "A", phone: "must not leak" }]);

    await expect(service.options()).resolves.toEqual([{ id: "1", name: "A" }]);
  });

  it("is capped at 1000 by the repository", () => {
    expect(MAX_OPTIONS).toBe(1000);
  });
});

describe("get", () => {
  it("returns the engineer", async () => {
    repo.findById.mockResolvedValue(row());

    await expect(service.get("eng-1", ctx)).resolves.toMatchObject({ id: "eng-1", version: 1 });
  });

  it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND, translated", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.get("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
      message: "مهندس الكهرباء غير موجود",
    });
  });
});

describe("create", () => {
  beforeEach(() => {
    repo.create.mockImplementation(async (data: Partial<ElectricalEngineerRow>) =>
      row({ ...data, id: "new-eng" }),
    );
  });

  it("creates in a transaction, with exactly the name, phone, email and status, and audits the new values", async () => {
    const dto = await service.create(actor, { name: "Omar Khaled", phone: "0100 123 4567" }, ctx);

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Omar Khaled", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ id: "new-eng", version: 1, email: null, status: "ACTIVE" });
    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "electrical_engineer.create",
      entity: "ElectricalEngineer",
      actorId: "admin-1",
      entityId: "new-eng",
      after: { name: "Omar Khaled", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
    expect(auditEntry()).not.toHaveProperty("before", expect.anything());
  });

  it("stores the email and status that were sent, and audits them", async () => {
    const dto = await service.create(
      actor,
      { name: "Omar Khaled", phone: "0100 123 4567", email: "omar@example.test", status: "INACTIVE" },
      ctx,
    );

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Omar Khaled", phone: "0100 123 4567", email: "omar@example.test", status: "INACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ email: "omar@example.test", status: "INACTIVE" });
    expect(auditEntry()).toMatchObject({
      after: { name: "Omar Khaled", phone: "0100 123 4567", email: "omar@example.test", status: "INACTIVE" },
    });
  });

  it("stores no email (null) when the body sends null", async () => {
    await service.create(actor, { name: "N", phone: "0100 123 4567", email: null }, ctx);

    expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ email: null, status: "ACTIVE" });
  });

  it("hands the repository only the known fields, even if the input carries more", async () => {
    const input = { name: "Omar Khaled", phone: "0100 123 4567", id: "chosen", version: 9 };

    await service.create(actor, input, ctx);

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Omar Khaled", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      tx,
    );
  });

  it("allows two engineers with the same name", async () => {
    await service.create(actor, { name: "Same Name", phone: "0100 123 4567" }, ctx);
    await service.create(actor, { name: "Same Name", phone: "0100 765 4321" }, ctx);

    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.create(actor, { name: "N", phone: "0100 123 4567" }, ctx)).rejects.toThrow(
      "audit down",
    );
  });
});

describe("update", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
    repo.update.mockImplementation(
      async (_id: string, _version: number, data: Partial<ElectricalEngineerRow>) => row({ ...data }),
    );
  });

  it("answers 404 for an unknown engineer and writes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.update(actor, "x", { name: "N" }, ctx))).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("changes only the fields that were sent and audits before and after", async () => {
    const dto = await service.update(actor, "eng-1", { phone: "0100 999 8888" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("eng-1", 1, { phone: "0100 999 8888" }, tx);
    expect(dto).toMatchObject({ name: "Omar Khaled", phone: "0100 999 8888" });
    expect(auditEntry()).toMatchObject({
      action: "electrical_engineer.update",
      entity: "ElectricalEngineer",
      actorId: "admin-1",
      entityId: "eng-1",
      before: { name: "Omar Khaled", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
      after: { name: "Omar Khaled", phone: "0100 999 8888", email: null, status: "ACTIVE" },
    });
  });

  it("sets an email, changes the status, and audits both before and after", async () => {
    const dto = await service.update(actor, "eng-1", { email: "omar@example.test", status: "INACTIVE" }, ctx);

    expect(repo.update).toHaveBeenCalledWith(
      "eng-1",
      1,
      { email: "omar@example.test", status: "INACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ email: "omar@example.test", status: "INACTIVE" });
    expect(auditEntry()).toMatchObject({
      before: { name: "Omar Khaled", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
      after: {
        name: "Omar Khaled",
        phone: "+20 100 123 4567",
        email: "omar@example.test",
        status: "INACTIVE",
      },
    });
  });

  it("clears the email when it is sent as null, and leaves the status alone", async () => {
    repo.findById.mockResolvedValue(row({ email: "old@example.test" }));

    const dto = await service.update(actor, "eng-1", { email: null }, ctx);

    expect(repo.update).toHaveBeenCalledWith("eng-1", 1, { email: null }, tx);
    expect(dto.email).toBeNull();
    expect(auditEntry()).toMatchObject({
      before: { email: "old@example.test", status: "ACTIVE" },
      after: { email: null, status: "ACTIVE" },
    });
  });

  it("does not touch the email or the status when they are not sent", async () => {
    repo.findById.mockResolvedValue(row({ email: "keep@example.test", status: "INACTIVE" }));

    await service.update(actor, "eng-1", { name: "New Name" }, ctx);

    expect(repo.update.mock.calls[0]?.[2]).toEqual({ name: "New Name" });
  });

  it("sends both fields when both are given", async () => {
    await service.update(actor, "eng-1", { name: "New Name", phone: "0100 999 8888" }, ctx);

    expect(repo.update.mock.calls[0]?.[2]).toEqual({ name: "New Name", phone: "0100 999 8888" });
  });

  it("takes the row's own version from the lock, whatever the caller sent", async () => {
    repo.lockVersion.mockResolvedValue(7);
    repo.findById.mockResolvedValue(row({ version: 7 }));

    await service.update(actor, "eng-1", { name: "N" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("eng-1", 7, { name: "N" }, tx);
  });

  it("locks before it reads, and reads what it audits as `before` after the lock", async () => {
    const order: string[] = [];
    repo.lockVersion.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    repo.findById.mockImplementation(async () => {
      order.push("read");
      return row();
    });

    await service.update(actor, "eng-1", { name: "N" }, ctx);

    expect(order).toEqual(["lock", "read"]);
  });

  it("answers 404 when the engineer is deleted between the lookup and the write", async () => {
    repo.update.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.update(actor, "eng-1", { name: "N" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
      message: "مهندس الكهرباء غير موجود",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.update.mockRejectedValue(new Error("connection lost"));

    await expect(service.update(actor, "eng-1", { name: "N" }, ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.update(actor, "eng-1", { name: "N" }, ctx)).rejects.toThrow("audit down");
  });

  describe("version", () => {
    it("refuses an If-Match that is not the current version: 409 with the current version, nothing written", async () => {
      repo.lockVersion.mockResolvedValue(4);

      const err = await failure(service.update(actor, "eng-1", { name: "N" }, ctxAr, 3));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ path: "version", value: 4 })]);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("accepts an If-Match that equals the current version", async () => {
      repo.lockVersion.mockResolvedValue(4);
      repo.findById.mockResolvedValue(row({ version: 4 }));

      await service.update(actor, "eng-1", { name: "N" }, ctx, 4);

      expect(repo.update).toHaveBeenCalledWith("eng-1", 4, { name: "N" }, tx);
    });

    it("does not insist on a version when the caller sent none", async () => {
      repo.lockVersion.mockResolvedValue(9);
      repo.findById.mockResolvedValue(row({ version: 9 }));

      await expect(service.update(actor, "eng-1", { name: "N" }, ctx)).resolves.toBeDefined();
    });

    it("answers 409 with the version it finds now when it loses the race for the row", async () => {
      repo.update.mockResolvedValue(null);
      repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const err = await failure(service.update(actor, "eng-1", { name: "N" }, ctx));

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
  it("answers 404 for an unknown engineer and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.remove(actor, "x", ctx))).toMatchObject({
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
    });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes inside a transaction and audits the deleted values, with no `after`", async () => {
    repo.findById.mockResolvedValue(row());

    await expect(service.remove(actor, "eng-1", ctx)).resolves.toBeUndefined();

    expect(repo.delete).toHaveBeenCalledWith("eng-1", 1, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "electrical_engineer.delete",
      entity: "ElectricalEngineer",
      actorId: "admin-1",
      entityId: "eng-1",
      before: { name: "Omar Khaled", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
    });
    expect(auditEntry()?.after).toBeUndefined();
  });

  it.each([
    ["any villa references", 1, 0],
    ["any daily report names", 0, 1],
  ])(
    "is blocked with 409 ELECTRICAL_ENGINEER_IN_USE while %s the engineer",
    async (_label, villas, dailyReports) => {
      repo.findById.mockResolvedValue(row({}, villas, dailyReports));

      const err = await failure(service.remove(actor, "eng-1", ctxAr));

      expect(err).toMatchObject({
        statusCode: 409,
        code: "ELECTRICAL_ENGINEER_IN_USE",
        message: "مهندس الكهرباء هذا مرتبط بفلل أو بتقارير يومية ولا يمكن حذفه",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("maps the foreign-key error (P2003) to the same 409 when a villa is linked after the check", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(prismaError("P2003"));

    expect(await failure(service.remove(actor, "eng-1", ctx))).toMatchObject({
      statusCode: 409,
      code: "ELECTRICAL_ENGINEER_IN_USE",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a stale If-Match with 409 and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(3);
    repo.findById.mockResolvedValue(row({ version: 3 }));

    const err = await failure(service.remove(actor, "eng-1", ctx, 2));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(err.details).toEqual([expect.objectContaining({ value: 3 })]);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 when the row moved between the lock and the delete", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockResolvedValue(false);
    repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const err = await failure(service.remove(actor, "eng-1", ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 404 when it was deleted by someone else after the check (P2025)", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.remove(actor, "eng-1", ctx))).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(new Error("connection lost"));

    await expect(service.remove(actor, "eng-1", ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails, so the delete can roll back", async () => {
    repo.findById.mockResolvedValue(row());
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.remove(actor, "eng-1", ctx)).rejects.toThrow("audit down");
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

  describe("phone", () => {
    it.each([
      "01001234567",
      "+201001234567",
      "+20 100 123 4567",
      "010-0123-4567",
      "12345",
      "12345678901234567890",
      "  01001234567  ",
    ])("accepts %j", (phone) => {
      expect(createElectricalEngineerSchema.safeParse({ name: "N", phone }).success).toBe(true);
    });

    it("trims the phone before storing it, and does not reformat it", () => {
      const result = createElectricalEngineerSchema.safeParse({ name: "N", phone: "  +20 100-123 4567  " });

      expect(result.success && result.data.phone).toBe("+20 100-123 4567");
    });

    it.each([
      "1234",
      "123456789012345678901",
      "abcde",
      "+",
      "++201001234",
      "0100 abc 4567",
      "-0100123456",
      "+ 20100123456",
      "(010)1234567",
      "010.123.4567",
      "٠١٠٠١٢٣٤٥٦٧",
      "",
      "     ",
    ])("rejects %j with exactly one phoneInvalid error", (phone) => {
      expect(issues(createElectricalEngineerSchema.safeParse({ name: "N", phone }))).toEqual([
        { path: "phone", message: "validation.phoneInvalid" },
      ]);
    });

    it("requires the phone", () => {
      expect(issues(createElectricalEngineerSchema.safeParse({ name: "N" }))).toEqual([
        { path: "phone", message: "validation.required" },
      ]);
    });
  });

  describe("name", () => {
    it("trims, and accepts 1 to 100 characters", () => {
      expect(createElectricalEngineerSchema.safeParse({ name: "  Omar  ", phone: "12345" }).data?.name).toBe(
        "Omar",
      );
      expect(
        createElectricalEngineerSchema.safeParse({ name: "x".repeat(100), phone: "12345" }).success,
      ).toBe(true);
    });

    it("rejects blank and over-long names", () => {
      expect(issues(createElectricalEngineerSchema.safeParse({ name: "   ", phone: "12345" }))).toEqual([
        { path: "name", message: "validation.nameRequired" },
      ]);
      expect(
        issues(createElectricalEngineerSchema.safeParse({ name: "x".repeat(101), phone: "12345" })),
      ).toEqual([{ path: "name", message: "validation.nameTooLong" }]);
    });
  });

  describe("email and status", () => {
    it("are optional on create, so existing callers keep working", () => {
      const result = createElectricalEngineerSchema.safeParse({ name: "N", phone: "12345" });

      expect(result.success && result.data).toEqual({ name: "N", phone: "12345" });
    });

    it("normalise the email on create: trimmed, lowercased, blank means none", () => {
      const parse = (email: unknown) =>
        createElectricalEngineerSchema.safeParse({ name: "N", phone: "12345", email });

      expect(parse("  Omar@Example.TEST ").data?.email).toBe("omar@example.test");
      expect(parse("   ").data?.email).toBeNull();
      expect(parse("").data?.email).toBeNull();
      expect(parse(null).data?.email).toBeNull();
      expect(issues(parse("not-an-email"))).toEqual([{ path: "email", message: "validation.emailInvalid" }]);
      expect(issues(parse(12))).toEqual([{ path: "email", message: "validation.required" }]);
    });

    it("accept ACTIVE and INACTIVE only", () => {
      const parse = (status: unknown) =>
        createElectricalEngineerSchema.safeParse({ name: "N", phone: "12345", status });

      expect(parse("ACTIVE").success).toBe(true);
      expect(parse("INACTIVE").success).toBe(true);
      for (const bad of ["active", "PAUSED", "", null, 1]) {
        expect(issues(parse(bad))).toEqual([{ path: "status", message: "validation.partyStatusInvalid" }]);
      }
    });

    it("count as a field on update: an email alone, a status alone, or a null that clears the email", () => {
      expect(updateElectricalEngineerSchema.safeParse({ email: "a@b.test" }).success).toBe(true);
      expect(updateElectricalEngineerSchema.safeParse({ status: "INACTIVE" }).success).toBe(true);
      expect(updateElectricalEngineerSchema.safeParse({ email: null }).success).toBe(true);
      expect(updateElectricalEngineerSchema.safeParse({ email: "" }).data?.email).toBeNull();
    });
  });

  describe("strict bodies", () => {
    it("rejects unknown keys on create and update", () => {
      expect(
        createElectricalEngineerSchema.safeParse({ name: "N", phone: "12345", villaCount: 5 }).success,
      ).toBe(false);
      expect(updateElectricalEngineerSchema.safeParse({ name: "N", id: "x" }).success).toBe(false);
      expect(updateElectricalEngineerSchema.safeParse({ name: "N", version: 3 }).success).toBe(false);
    });

    it("requires at least one field on update", () => {
      expect(issues(updateElectricalEngineerSchema.safeParse({}))).toEqual([
        { path: "", message: "validation.atLeastOneField" },
      ]);
      expect(updateElectricalEngineerSchema.safeParse({ phone: "12345" }).success).toBe(true);
      expect(updateElectricalEngineerSchema.safeParse({ name: "N" }).success).toBe(true);
    });
  });

  describe("list query", () => {
    const parse = (input: Record<string, unknown>) => listElectricalEngineersQuerySchema.safeParse(input);

    it("applies the shared pagination: limit 1000 ok, 1001 rejected", () => {
      expect(parse({ limit: "1000" }).success).toBe(true);
      expect(parse({ limit: "1001" }).success).toBe(false);
    });

    it("accepts only name and createdAt for sorting", () => {
      for (const sort of ["name", "name:asc", "createdAt:desc"]) expect(parse({ sort }).success).toBe(true);
      for (const sort of ["phone", "id:asc", "name:up", "name:asc:x", ":asc"]) {
        expect(issues(parse({ sort }))).toEqual([
          { path: "sort", message: "validation.sortNameCreatedAtInvalid" },
        ]);
      }
    });

    it("accepts a status filter of ACTIVE or INACTIVE only", () => {
      expect(parse({ status: "ACTIVE" }).data?.status).toBe("ACTIVE");
      expect(parse({ status: "INACTIVE" }).data?.status).toBe("INACTIVE");
      expect(parse({}).data?.status).toBeUndefined();
      for (const status of ["active", "PAUSED", ""]) {
        expect(issues(parse({ status }))).toEqual([
          { path: "status", message: "validation.partyStatusInvalid" },
        ]);
      }
    });

    it("limits search to 100 characters, trimmed", () => {
      expect(parse({ search: "x".repeat(100) }).success).toBe(true);
      expect(issues(parse({ search: "x".repeat(101) }))).toEqual([
        { path: "search", message: "validation.searchTooLong" },
      ]);
      expect(parse({ search: "  omar  " }).data?.search).toBe("omar");
    });
  });
});
