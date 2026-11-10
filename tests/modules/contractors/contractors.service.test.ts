import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { MAX_OPTIONS } from "../../../src/modules/contractors/dto/contractors.dto.js";
import type {
  ContractorVillaRow,
  ContractorRow,
  ContractorsRepository,
  Db,
} from "../../../src/modules/contractors/repository/contractors.repository.js";
import { ContractorsService } from "../../../src/modules/contractors/service/contractors.service.js";
import {
  contractorSummaryQuerySchema,
  createContractorSchema,
  listContractorsQuerySchema,
  updateContractorSchema,
  type ContractorSummaryQuery,
  type ListContractorsQuery,
} from "../../../src/modules/contractors/validators/contractors.validators.js";

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

function row(overrides: Partial<ContractorRow> = {}, villas = 0): ContractorRow {
  return {
    id: "con-1",
    name: "Nile Builders",
    phone: "+20 100 123 4567",
    email: null,
    status: "ACTIVE",
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    _count: { villas },
    ...overrides,
  };
}

function villaRow(number: string, overrides: Partial<ContractorVillaRow> = {}): ContractorVillaRow {
  return {
    id: `id-${number}`,
    villaNumber: number,
    area: { name: "New Cairo" },
    block: "B1",
    plot: "12",
    startDate: new Date("2026-01-05T00:00:00.000Z"),
    targetDate: null,
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
    listVillas: vi.fn(),
    countLinks: vi.fn(),
    figures: vi.fn(),
  };
}

// The permission codes a user holds, as the permissions repository answers them.
function makePermissions(codes: string[] = []) {
  return { getUserCodes: vi.fn(async () => codes) };
}

let repo: ReturnType<typeof makeRepo>;
let service: ContractorsService;
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
  repo.countLinks.mockResolvedValue(0);
  repo.figures.mockResolvedValue({});
  service = new ContractorsService(repo as unknown as ContractorsRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListContractorsQuery> = {}): ListContractorsQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});
const summaryQuery = (overrides: Partial<ContractorSummaryQuery> = {}): ContractorSummaryQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("defaults to name ascending, page 1, 20 per page, and maps rows to DTOs with villaCount", async () => {
    repo.list.mockResolvedValue({ rows: [row({}, 3), row({ id: "con-2" })], total: 45 });

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
      id: "con-1",
      name: "Nile Builders",
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

    await service.list(query({ search: "nile", page: 3, limit: 50 }));

    expect(repo.list).toHaveBeenCalledWith({
      search: "nile",
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
      rows: [row({ email: "a@b.test", status: "INACTIVE" }), row({ id: "con-2" })],
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
    "maps sort %j to %s %s, falling back to the default off the whitelist",
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
  it("returns only id and name, capped by the repository at 1000", async () => {
    repo.options.mockResolvedValue([{ id: "1", name: "A", phone: "must not leak" }]);

    await expect(service.options()).resolves.toEqual([{ id: "1", name: "A" }]);
    expect(MAX_OPTIONS).toBe(1000);
  });
});

describe("get", () => {
  it("returns the contractor", async () => {
    repo.findById.mockResolvedValue(row({}, 2));

    await expect(service.get("con-1", ctx)).resolves.toMatchObject({ id: "con-1", villaCount: 2 });
  });

  it("answers 404 CONTRACTOR_NOT_FOUND, translated", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.get("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
      message: "المقاول غير موجود",
    });
  });
});

describe("summary", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
    repo.listVillas.mockResolvedValue({ rows: [villaRow("P-0001")], total: 7 });
  });

  it("answers 404 for an unknown contractor and lists no villas", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.summary("missing", summaryQuery(), ctxAr))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
      message: "المقاول غير موجود",
    });
    expect(repo.listVillas).not.toHaveBeenCalled();
  });

  it("returns the contractor, the villa count, the villas and the page meta", async () => {
    const result = await service.summary("con-1", summaryQuery(), ctx);

    expect(result.summary.contractor).toEqual({
      id: "con-1",
      name: "Nile Builders",
      phone: "+20 100 123 4567",
    });
    expect(result.summary.villaCount).toBe(7);
    expect(result.summary).not.toHaveProperty("totals");
    expect(result.summary.villas).toEqual([
      {
        id: "id-P-0001",
        villaNumber: "P-0001",
        area: "New Cairo",
        block: "B1",
        plot: "12",
        startDate: "2026-01-05",
        targetDate: null,
      },
    ]);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 7, totalPages: 1 });
  });

  it("defaults to villaNumber ascending, page 1, 20 per page", async () => {
    await service.summary("con-1", summaryQuery(), ctx);

    expect(repo.listVillas).toHaveBeenCalledWith({
      contractorId: "con-1",
      sort: { field: "villaNumber", direction: "asc" },
      skip: 0,
      take: 20,
    });
  });

  it("reports a count of zero for a contractor with no villas", async () => {
    repo.listVillas.mockResolvedValue({ rows: [], total: 0 });

    const result = await service.summary("con-1", summaryQuery(), ctx);

    expect(result.summary.villaCount).toBe(0);
    expect(result.summary.villas).toEqual([]);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it.each([
    ["villaNumber", "villaNumber", "asc"],
    ["villaNumber:desc", "villaNumber", "desc"],
    ["startDate", "startDate", "asc"],
    ["startDate:desc", "startDate", "desc"],
    ["targetDate:asc", "targetDate", "asc"],
    ["targetDate:desc", "targetDate", "desc"],
    ["assignedAt:desc", "villaNumber", "asc"],
  ])(
    "maps sort %j to %s %s, falling back to the default off the whitelist",
    async (sort, field, direction) => {
      await service.summary("con-1", summaryQuery({ sort }), ctx);

      expect(repo.listVillas.mock.calls[0]?.[0].sort).toEqual({ field, direction });
    },
  );

  it("applies the page window", async () => {
    await service.summary("con-1", summaryQuery({ page: 3, limit: 50 }), ctx);

    expect(repo.listVillas.mock.calls[0]?.[0]).toMatchObject({ skip: 100, take: 50 });
  });

  it("is read-only: it opens no transaction and writes no audit entry", async () => {
    await service.summary("con-1", summaryQuery(), ctx);

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("summary: the work of the contractor in the other resources", () => {
  const NOW = new Date("2026-10-12T15:37:00.000Z");
  const policy = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
  const figures = {
    openWorks: { total: 10n, notStarted: 1n, inProgress: 2n, delayed: 3n, done: 4n, overdue: 5n },
    smallWorks: { total: 9n, pending: 5n, done: 4n, overdue: 2n, dueSoon: 1n },
    dailyReports: { count: 6n, lastReportDate: new Date("2026-10-11T00:00:00.000Z") },
    labour: { entries: 3n, totalLabour: 45n, lastLabourDate: new Date("2026-10-10T00:00:00.000Z") },
  };
  const employee = { id: "emp-1", role: "EMPLOYEE" as const };
  const build = (codes: string[] = []) =>
    new ContractorsService(
      repo as unknown as ContractorsRepository,
      () => NOW,
      policy,
      makePermissions(codes) as never,
    );

  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
    repo.listVillas.mockResolvedValue({ rows: [], total: 0 });
    repo.figures.mockResolvedValue(figures);
  });

  it("gives an ADMIN every section, and asks for them all", async () => {
    const { summary } = await build().summary("con-1", summaryQuery(), ctx, { id: "a", role: "ADMIN" });

    expect(repo.figures.mock.calls[0]?.[1]).toEqual(["openWorks", "smallWorks", "dailyReports", "labour"]);
    expect(summary.openWorks).toEqual({
      total: 10,
      byStatus: { NOT_STARTED: 1, IN_PROGRESS: 2, DELAYED: 3, DONE: 4 },
      delayed: 3,
      overdue: 5,
    });
    expect(summary.smallWorks).toEqual({ total: 9, pending: 5, done: 4, overdue: 2, dueSoon: 1 });
    expect(summary.dailyReports).toEqual({ count: 6, lastReportDate: "2026-10-11" });
    expect(summary.labour).toEqual({ entries: 3, totalLabour: 45, lastLabourDate: "2026-10-10" });
  });

  it("cuts each section to its own permission and does not query the others", async () => {
    const { summary } = await build(["open-works:read", "daily-labour:read"]).summary(
      "con-1",
      summaryQuery(),
      ctx,
      employee,
    );

    expect(repo.figures.mock.calls[0]?.[1]).toEqual(["openWorks", "labour"]);
    repo.figures.mockResolvedValue({ openWorks: figures.openWorks, labour: figures.labour });
    const again = await build(["open-works:read", "daily-labour:read"]).summary(
      "con-1",
      summaryQuery(),
      ctx,
      employee,
    );
    expect(again.summary.smallWorks).toBeNull();
    expect(again.summary.dailyReports).toBeNull();
    expect(again.summary.openWorks).not.toBeNull();
    expect(summary.villaCount).toBe(0);
  });

  it.each([
    ["open-works:read", "openWorks"],
    ["small-works:read", "smallWorks"],
    ["daily-reports:read", "dailyReports"],
    ["daily-labour:read", "labour"],
  ])("%s opens the %s section and no other", async (code, section) => {
    await build([code]).summary("con-1", summaryQuery(), ctx, employee);

    expect(repo.figures.mock.calls[0]?.[1]).toEqual([section]);
  });

  it("gives an employee with no permission of those four null sections, and queries none", async () => {
    repo.figures.mockResolvedValue({});

    const { summary } = await build(["contractors:summary", "villas:read"]).summary(
      "con-1",
      summaryQuery(),
      ctx,
      employee,
    );

    expect(repo.figures.mock.calls[0]?.[1]).toEqual([]);
    expect(summary.openWorks).toBeNull();
    expect(summary.smallWorks).toBeNull();
    expect(summary.dailyReports).toBeNull();
    expect(summary.labour).toBeNull();
  });

  it("is not cut when nobody is named (the export): every section is read", async () => {
    await build().summary("con-1", summaryQuery(), ctx);

    expect(repo.figures.mock.calls[0]?.[1]).toEqual(["openWorks", "smallWorks", "dailyReports", "labour"]);
  });

  it("counts from the UTC day of the clock, and the small works' two days from the deadline policy", async () => {
    await build().summary("con-1", summaryQuery(), ctx);

    const [id, , today, window] = repo.figures.mock.calls[0]!;
    expect(id).toBe("con-1");
    expect((today as Date).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    // 15:37Z is 18:37 in Kuwait: the small works' today is the 12th there, and the alert reaches the 13th.
    expect(window).toEqual({ today: "2026-10-12", horizon: "2026-10-13" });
  });

  it("answers zeros and null dates for a contractor with nothing, never a null section", async () => {
    repo.figures.mockResolvedValue({
      openWorks: { total: 0n, notStarted: 0n, inProgress: 0n, delayed: 0n, done: 0n, overdue: 0n },
      smallWorks: { total: 0n, pending: 0n, done: 0n, overdue: 0n, dueSoon: 0n },
      dailyReports: { count: 0n, lastReportDate: null },
      labour: { entries: 0n, totalLabour: 0n, lastLabourDate: null },
    });

    const { summary } = await build().summary("con-1", summaryQuery(), ctx);

    expect(summary.openWorks).toMatchObject({ total: 0, delayed: 0, overdue: 0 });
    expect(summary.smallWorks).toMatchObject({ total: 0, pending: 0, done: 0, overdue: 0, dueSoon: 0 });
    expect(summary.dailyReports).toEqual({ count: 0, lastReportDate: null });
    expect(summary.labour).toEqual({ entries: 0, totalLabour: 0, lastLabourDate: null });
  });

  it("turns a numeric sum that arrives as text or a decimal into a plain number", async () => {
    repo.figures.mockResolvedValue({
      labour: { entries: 2, totalLabour: { valueOf: () => "17" } as never, lastLabourDate: null },
    });

    expect((await build().summary("con-1", summaryQuery(), ctx)).summary.labour?.totalLabour).toBe(17);
  });
});

describe("create", () => {
  beforeEach(() => {
    repo.create.mockImplementation(async (data: Partial<ContractorRow>) => row({ ...data, id: "new-con" }));
  });

  it("creates in a transaction, with exactly the name, phone, email and status, and audits the new values", async () => {
    const dto = await service.create(actor, { name: "Nile Builders", phone: "0100 123 4567" }, ctx);

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Nile Builders", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ id: "new-con", villaCount: 0, email: null, status: "ACTIVE" });
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "contractor.create",
      entity: "Contractor",
      actorId: "admin-1",
      entityId: "new-con",
      after: { name: "Nile Builders", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
  });

  it("stores the email and status that were sent, and audits them", async () => {
    const dto = await service.create(
      actor,
      { name: "Nile Builders", phone: "0100 123 4567", email: "office@nile.test", status: "INACTIVE" },
      ctx,
    );

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Nile Builders", phone: "0100 123 4567", email: "office@nile.test", status: "INACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ email: "office@nile.test", status: "INACTIVE" });
    expect(auditEntry()).toMatchObject({
      after: { name: "Nile Builders", phone: "0100 123 4567", email: "office@nile.test", status: "INACTIVE" },
    });
  });

  it("stores no email (null) when the body sends null", async () => {
    await service.create(actor, { name: "N", phone: "0100 123 4567", email: null }, ctx);

    expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ email: null, status: "ACTIVE" });
  });

  it("hands the repository only the known fields, even if the input carries more", async () => {
    const input = { name: "N", phone: "0100 123 4567", id: "chosen", version: 9 };

    await service.create(actor, input, ctx);

    expect(repo.create).toHaveBeenCalledWith(
      { name: "N", phone: "0100 123 4567", email: null, status: "ACTIVE" },
      tx,
    );
  });

  it("allows two contractors with the same name", async () => {
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
    repo.update.mockImplementation(async (_id: string, _version: number, data: Partial<ContractorRow>) =>
      row({ ...data }),
    );
  });

  it("answers 404 for an unknown contractor and writes nothing", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.update(actor, "x", { name: "N" }, ctx))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("changes only the fields that were sent and audits before and after", async () => {
    const dto = await service.update(actor, "con-1", { phone: "0100 999 8888" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("con-1", 1, { phone: "0100 999 8888" }, tx);
    expect(dto).toMatchObject({ name: "Nile Builders", phone: "0100 999 8888" });
    expect(auditEntry()).toMatchObject({
      action: "contractor.update",
      entity: "Contractor",
      actorId: "admin-1",
      entityId: "con-1",
      before: { name: "Nile Builders", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
      after: { name: "Nile Builders", phone: "0100 999 8888", email: null, status: "ACTIVE" },
    });
  });

  it("sets an email, changes the status, and audits both before and after", async () => {
    const dto = await service.update(actor, "con-1", { email: "office@nile.test", status: "INACTIVE" }, ctx);

    expect(repo.update).toHaveBeenCalledWith(
      "con-1",
      1,
      { email: "office@nile.test", status: "INACTIVE" },
      tx,
    );
    expect(dto).toMatchObject({ email: "office@nile.test", status: "INACTIVE" });
    expect(auditEntry()).toMatchObject({
      before: { name: "Nile Builders", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
      after: {
        name: "Nile Builders",
        phone: "+20 100 123 4567",
        email: "office@nile.test",
        status: "INACTIVE",
      },
    });
  });

  it("clears the email when it is sent as null, and leaves the status alone", async () => {
    repo.findById.mockResolvedValue(row({ email: "old@nile.test" }));

    const dto = await service.update(actor, "con-1", { email: null }, ctx);

    expect(repo.update).toHaveBeenCalledWith("con-1", 1, { email: null }, tx);
    expect(dto.email).toBeNull();
    expect(auditEntry()).toMatchObject({
      before: { email: "old@nile.test", status: "ACTIVE" },
      after: { email: null, status: "ACTIVE" },
    });
  });

  it("does not touch the email or the status when they are not sent", async () => {
    repo.findById.mockResolvedValue(row({ email: "keep@nile.test", status: "INACTIVE" }));

    await service.update(actor, "con-1", { name: "New Name" }, ctx);

    expect(repo.update.mock.calls[0]?.[2]).toEqual({ name: "New Name" });
  });

  it("answers 404 when the contractor is deleted between the lookup and the write (P2025)", async () => {
    repo.update.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.update(actor, "con-1", { name: "N" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
      message: "المقاول غير موجود",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.update.mockRejectedValue(new Error("connection lost"));

    await expect(service.update(actor, "con-1", { name: "N" }, ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.update(actor, "con-1", { name: "N" }, ctx)).rejects.toThrow("audit down");
  });
});

describe("remove", () => {
  it("answers 404 for an unknown contractor and deletes nothing", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.remove(actor, "x", ctx))).toMatchObject({ code: "CONTRACTOR_NOT_FOUND" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes inside a transaction and audits the deleted values, with no `after`", async () => {
    repo.findById.mockResolvedValue(row());

    await expect(service.remove(actor, "con-1", ctx)).resolves.toBeUndefined();

    expect(repo.delete).toHaveBeenCalledWith("con-1", 1, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "contractor.delete",
      entity: "Contractor",
      actorId: "admin-1",
      entityId: "con-1",
      before: { name: "Nile Builders", phone: "+20 100 123 4567", email: null, status: "ACTIVE" },
    });
    expect(auditEntry()?.after).toBeUndefined();
  });

  it.each([1, 7])(
    "is blocked with 409 CONTRACTOR_HAS_VILLAS while %i villas, open works, daily reports, small works or labour rows name it",
    async (links) => {
      repo.findById.mockResolvedValue(row());
      repo.countLinks.mockResolvedValue(links);

      const err = await failure(service.remove(actor, "con-1", ctxAr));

      expect(err).toMatchObject({
        statusCode: 409,
        code: "CONTRACTOR_HAS_VILLAS",
        message: "هذا المقاول مرتبط بفلل أو بسجلات ولا يمكن حذفه",
      });
      expect(repo.countLinks).toHaveBeenCalledWith("con-1", tx);
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("maps the foreign-key error (P2003) to the same 409 when a villa is linked after the check", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(prismaError("P2003"));

    expect(await failure(service.remove(actor, "con-1", ctx))).toMatchObject({
      statusCode: 409,
      code: "CONTRACTOR_HAS_VILLAS",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 404 when it was deleted by someone else after the check (P2025)", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.remove(actor, "con-1", ctx))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.findById.mockResolvedValue(row());
    repo.delete.mockRejectedValue(new Error("connection lost"));

    await expect(service.remove(actor, "con-1", ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails, so the delete can roll back", async () => {
    repo.findById.mockResolvedValue(row());
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.remove(actor, "con-1", ctx)).rejects.toThrow("audit down");
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

  it("uses the shared name and phone rules, one error per bad field", () => {
    expect(createContractorSchema.safeParse({ name: "N", phone: "12345" }).success).toBe(true);
    expect(issues(createContractorSchema.safeParse({ name: " ", phone: "12" }))).toEqual([
      { path: "name", message: "validation.nameRequired" },
      { path: "phone", message: "validation.phoneInvalid" },
    ]);
    expect(issues(createContractorSchema.safeParse({ name: "N" }))).toEqual([
      { path: "phone", message: "validation.required" },
    ]);
  });

  describe("email and status", () => {
    it("are optional on create, so existing callers keep working", () => {
      const result = createContractorSchema.safeParse({ name: "N", phone: "12345" });

      expect(result.success && result.data).toEqual({ name: "N", phone: "12345" });
    });

    it("normalise the email on create: trimmed, lowercased, blank means none", () => {
      const parse = (email: unknown) =>
        createContractorSchema.safeParse({ name: "N", phone: "12345", email });

      expect(parse("  Office@Nile.TEST ").data?.email).toBe("office@nile.test");
      expect(parse("   ").data?.email).toBeNull();
      expect(parse("").data?.email).toBeNull();
      expect(parse(null).data?.email).toBeNull();
      expect(issues(parse("not-an-email"))).toEqual([{ path: "email", message: "validation.emailInvalid" }]);
      expect(issues(parse(12))).toEqual([{ path: "email", message: "validation.required" }]);
    });

    it("accept ACTIVE and INACTIVE only", () => {
      const parse = (status: unknown) =>
        createContractorSchema.safeParse({ name: "N", phone: "12345", status });

      expect(parse("ACTIVE").success).toBe(true);
      expect(parse("INACTIVE").success).toBe(true);
      for (const bad of ["active", "PAUSED", "", null, 1]) {
        expect(issues(parse(bad))).toEqual([{ path: "status", message: "validation.partyStatusInvalid" }]);
      }
    });

    it("count as a field on update: an email alone, a status alone, or a null that clears the email", () => {
      expect(updateContractorSchema.safeParse({ email: "a@b.test" }).success).toBe(true);
      expect(updateContractorSchema.safeParse({ status: "INACTIVE" }).success).toBe(true);
      expect(updateContractorSchema.safeParse({ email: null }).success).toBe(true);
      expect(updateContractorSchema.safeParse({ email: "" }).data?.email).toBeNull();
    });
  });

  it("rejects unknown keys, and requires at least one field on update", () => {
    expect(createContractorSchema.safeParse({ name: "N", phone: "12345", villaCount: 1 }).success).toBe(
      false,
    );
    expect(updateContractorSchema.safeParse({ name: "N", id: "x" }).success).toBe(false);
    expect(issues(updateContractorSchema.safeParse({}))).toEqual([
      { path: "", message: "validation.atLeastOneField" },
    ]);
  });

  describe("list query", () => {
    const parse = (input: Record<string, unknown>) => listContractorsQuerySchema.safeParse(input);

    it("applies the shared pagination: limit 1000 ok, 1001 rejected", () => {
      expect(parse({ limit: "1000" }).success).toBe(true);
      expect(parse({ limit: "1001" }).success).toBe(false);
    });

    it("accepts only name and createdAt for sorting", () => {
      for (const sort of ["name", "name:asc", "createdAt:desc"]) expect(parse({ sort }).success).toBe(true);
      for (const sort of ["phone", "id:asc", "name:up", ":asc"]) {
        expect(issues(parse({ sort }))).toEqual([
          { path: "sort", message: "validation.sortNameCreatedAtInvalid" },
        ]);
      }
    });

    it("accepts a status filter of ACTIVE or INACTIVE only", () => {
      expect(parse({ status: "ACTIVE" }).data?.status).toBe("ACTIVE");
      expect(parse({ status: "INACTIVE" }).data?.status).toBe("INACTIVE");
      expect(parse({}).data?.status).toBeUndefined();
      for (const status of ["active", "PAUSED", "OPEN", ""]) {
        expect(issues(parse({ status }))).toEqual([
          { path: "status", message: "validation.partyStatusInvalid" },
        ]);
      }
    });

    it("limits search to 100 characters", () => {
      expect(parse({ search: "x".repeat(100) }).success).toBe(true);
      expect(issues(parse({ search: "x".repeat(101) }))).toEqual([
        { path: "search", message: "validation.searchTooLong" },
      ]);
    });
  });

  describe("summary query", () => {
    const parse = (input: Record<string, unknown>) => contractorSummaryQuerySchema.safeParse(input);

    it("applies the shared pagination: limit 1000 ok, 1001 rejected", () => {
      expect(parse({ limit: "1000" }).success).toBe(true);
      expect(parse({ limit: "1001" }).success).toBe(false);
    });

    it("has no status filter any more: the parameter is dropped", () => {
      expect(parse({ status: "CLOSED" }).data).toEqual({ page: 1, limit: 20 });
    });

    it("accepts only villaNumber, startDate and targetDate for sorting", () => {
      for (const sort of ["villaNumber", "startDate:desc", "targetDate:asc"]) {
        expect(parse({ sort }).success).toBe(true);
      }
      for (const sort of ["name", "assignedAt", "status:asc", "startDate:up", ":asc"]) {
        expect(issues(parse({ sort }))).toEqual([
          { path: "sort", message: "validation.sortContractorVillasInvalid" },
        ]);
      }
    });
  });
});
