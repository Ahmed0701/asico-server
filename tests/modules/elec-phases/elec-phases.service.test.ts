import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { MAX_OPTIONS } from "../../../src/modules/elec-phases/dto/elec-phases.dto.js";
import type {
  Db,
  ElecPhaseRow,
  ElecPhasesRepository,
} from "../../../src/modules/elec-phases/repository/elec-phases.repository.js";
import { ElecPhasesService } from "../../../src/modules/elec-phases/service/elec-phases.service.js";
import {
  createElecPhaseSchema,
  listElecPhasesQuerySchema,
  reorderElecPhasesSchema,
  updateElecPhaseSchema,
  type ListElecPhasesQuery,
} from "../../../src/modules/elec-phases/validators/elec-phases.validators.js";

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

function row(overrides: Partial<ElecPhaseRow> = {}): ElecPhaseRow {
  return {
    id: "ph-1",
    name: "Ceiling Piping",
    sortOrder: 1,
    status: "ACTIVE",
    progressRatio: 0,
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    list: vi.fn(),
    options: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    lockOrder: vi.fn(),
    seedProgressRows: vi.fn(),
    deleteZeroProgress: vi.fn(),
    create: vi.fn(),
    lockVersion: vi.fn(),
    lockAll: vi.fn(),
    update: vi.fn(),
    setSortOrder: vi.fn(),
    delete: vi.fn(),
    countUsage: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let service: ElecPhasesService;
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
  repo.findByName.mockResolvedValue(null);
  repo.countUsage.mockResolvedValue(0);
  service = new ElecPhasesService(repo as unknown as ElecPhasesRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListElecPhasesQuery> = {}): ListElecPhasesQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("returns page 1 with 20 per page, maps rows to DTOs and passes no status filter", async () => {
    repo.list.mockResolvedValue({ rows: [row(), row({ id: "ph-2", sortOrder: 2 })], total: 45 });

    const result = await service.list(query());

    expect(repo.list).toHaveBeenCalledWith({ status: undefined, skip: 0, take: 20 });
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.items[0]).toEqual({
      id: "ph-1",
      name: "Ceiling Piping",
      sortOrder: 1,
      progressRatio: 0,
      status: "ACTIVE",
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-05T05:06:07.890Z",
    });
  });

  it("passes the status filter and the page window through", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ status: "INACTIVE", page: 3, limit: 50 }));

    expect(repo.list).toHaveBeenCalledWith({ status: "INACTIVE", skip: 100, take: 50 });
  });

  it("reports one empty page when there is nothing", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    expect((await service.list(query())).meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });
});

describe("options", () => {
  it("returns only id and name", async () => {
    repo.options.mockResolvedValue([{ id: "1", name: "A", status: "ACTIVE", sortOrder: 1 }]);

    await expect(service.options()).resolves.toEqual([{ id: "1", name: "A" }]);
  });

  it("is capped at 1000 by the repository", () => {
    expect(MAX_OPTIONS).toBe(1000);
  });
});

describe("get", () => {
  it("returns the phase", async () => {
    repo.findById.mockResolvedValue(row());

    await expect(service.get("ph-1", ctx)).resolves.toMatchObject({ id: "ph-1", version: 1 });
  });

  it("answers 404 ELEC_PHASE_NOT_FOUND, translated", async () => {
    repo.findById.mockResolvedValue(null);

    expect(await failure(service.get("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
      message: "مرحلة الكهرباء غير موجودة",
    });
  });
});

describe("create", () => {
  beforeEach(() => {
    repo.create.mockImplementation(async (data: { name: string; status: "ACTIVE" | "INACTIVE" }) =>
      row({ ...data, id: "new-ph", sortOrder: 7 }),
    );
  });

  it("creates in a transaction, ACTIVE by default, and audits the new values", async () => {
    const dto = await service.create(actor, { name: "Conduit Test" }, ctx);

    expect(repo.create).toHaveBeenCalledWith(
      { name: "Conduit Test", status: "ACTIVE", progressRatio: 0 },
      tx,
    );
    expect(dto).toMatchObject({ id: "new-ph", name: "Conduit Test", sortOrder: 7, status: "ACTIVE" });
    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "elec_phase.create",
      entity: "ElecPhase",
      actorId: "admin-1",
      entityId: "new-ph",
      after: { name: "Conduit Test", status: "ACTIVE", progressRatio: 0, sortOrder: 7 },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
    expect(auditEntry()).not.toHaveProperty("before", expect.anything());
  });

  it("gives every villa a progress row at 0 for the new phase, in the transaction, before the audit entry", async () => {
    await service.create(actor, { name: "Conduit Test" }, ctx);

    expect(repo.seedProgressRows).toHaveBeenCalledWith("new-ph", tx);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
    expect(order(repo.create)).toBeLessThan(order(repo.seedProgressRows));
    expect(order(repo.seedProgressRows)).toBeLessThan(order(vi.mocked(audit.record)));
  });

  it("seeds the rows of an INACTIVE phase too", async () => {
    await service.create(actor, { name: "Spare", status: "INACTIVE" }, ctx);

    expect(repo.seedProgressRows).toHaveBeenCalledWith("new-ph", tx);
  });

  it("writes no rows when the name is taken, and fails as a whole when the rows cannot be written", async () => {
    repo.findByName.mockResolvedValue({ id: "other" });
    await failure(service.create(actor, { name: "taken" }, ctx));
    expect(repo.seedProgressRows).not.toHaveBeenCalled();

    repo.findByName.mockResolvedValue(null);
    repo.seedProgressRows.mockRejectedValue(new Error("boom"));
    await expect(service.create(actor, { name: "N" }, ctx)).rejects.toThrow("boom");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("creates the phase INACTIVE when asked to", async () => {
    await service.create(actor, { name: "Spare", status: "INACTIVE" }, ctx);

    expect(repo.create).toHaveBeenCalledWith({ name: "Spare", status: "INACTIVE", progressRatio: 0 }, tx);
  });

  it("takes the order lock before it looks at the name or the end of the list", async () => {
    const order: string[] = [];
    repo.lockOrder.mockImplementation(async () => void order.push("lock"));
    repo.findByName.mockImplementation(async () => {
      order.push("name");
      return null;
    });
    repo.create.mockImplementation(async () => {
      order.push("create");
      return row();
    });

    await service.create(actor, { name: "N" }, ctx);

    expect(order).toEqual(["lock", "name", "create"]);
    expect(repo.lockOrder).toHaveBeenCalledWith(tx);
  });

  it("refuses a name another phase already has: 409 ELEC_PHASE_NAME_TAKEN, nothing written", async () => {
    repo.findByName.mockResolvedValue({ id: "other" });

    const err = await failure(service.create(actor, { name: "wall piping" }, ctxAr));

    expect(err).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_NAME_TAKEN",
      message: "توجد مرحلة كهرباء بهذا الاسم بالفعل",
    });
    expect(err.details).toEqual([{ path: "name", message: "توجد مرحلة كهرباء بهذا الاسم بالفعل" }]);
    expect(repo.findByName).toHaveBeenCalledWith("wall piping", tx);
    expect(repo.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 ELEC_PHASE_NAME_TAKEN when the unique index catches a name created a moment earlier", async () => {
    repo.create.mockRejectedValue(prismaError("P2002"));

    expect(await failure(service.create(actor, { name: "N" }, ctx))).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_NAME_TAKEN",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.create.mockRejectedValue(new Error("connection lost"));

    await expect(service.create(actor, { name: "N" }, ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.create(actor, { name: "N" }, ctx)).rejects.toThrow("audit down");
  });
});

describe("update", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
    repo.update.mockImplementation(async (_id: string, version: number, data: Partial<ElecPhaseRow>) =>
      row({ ...data, version: version + 1 }),
    );
  });

  it("answers 404 for an unknown phase and writes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.update(actor, "x", { name: "N" }, ctx))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("changes only the fields that were sent and audits before and after", async () => {
    const dto = await service.update(actor, "ph-1", { status: "INACTIVE" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("ph-1", 1, { status: "INACTIVE" }, tx);
    expect(dto).toMatchObject({ name: "Ceiling Piping", status: "INACTIVE", version: 2 });
    expect(auditEntry()).toMatchObject({
      action: "elec_phase.update",
      entity: "ElecPhase",
      actorId: "admin-1",
      entityId: "ph-1",
      before: { name: "Ceiling Piping", status: "ACTIVE", sortOrder: 1 },
      after: { name: "Ceiling Piping", status: "INACTIVE", sortOrder: 1 },
    });
  });

  it("sends both fields when both are given", async () => {
    await service.update(actor, "ph-1", { name: "Ceiling Conduit", status: "INACTIVE" }, ctx);

    expect(repo.update.mock.calls[0]?.[2]).toEqual({ name: "Ceiling Conduit", status: "INACTIVE" });
  });

  it("does not touch the position: only a reorder moves a phase", async () => {
    await service.update(actor, "ph-1", { name: "Renamed" }, ctx);

    expect(repo.update.mock.calls[0]?.[2]).not.toHaveProperty("sortOrder");
  });

  it("checks a new name against the other phases, ignoring case, inside the transaction", async () => {
    repo.findByName.mockResolvedValue({ id: "other" });

    const err = await failure(service.update(actor, "ph-1", { name: "SLEEVES" }, ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "ELEC_PHASE_NAME_TAKEN" });
    expect(err.details).toEqual([expect.objectContaining({ path: "name" })]);
    expect(repo.findByName).toHaveBeenCalledWith("SLEEVES", tx);
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("lets a phase change the case of its own name", async () => {
    repo.findByName.mockResolvedValue({ id: "ph-1" });

    await expect(service.update(actor, "ph-1", { name: "ceiling piping" }, ctx)).resolves.toBeDefined();
    expect(repo.update).toHaveBeenCalledWith("ph-1", 1, { name: "ceiling piping" }, tx);
  });

  it("does not look at names when the name is not part of the update", async () => {
    await service.update(actor, "ph-1", { status: "INACTIVE" }, ctx);

    expect(repo.findByName).not.toHaveBeenCalled();
  });

  it("answers 409 ELEC_PHASE_NAME_TAKEN when the unique index catches a rename that raced", async () => {
    repo.update.mockRejectedValue(prismaError("P2002"));

    expect(await failure(service.update(actor, "ph-1", { name: "N" }, ctx))).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_NAME_TAKEN",
    });
  });

  it("takes the row's own version from the lock, whatever the caller sent", async () => {
    repo.lockVersion.mockResolvedValue(7);
    repo.findById.mockResolvedValue(row({ version: 7 }));

    await service.update(actor, "ph-1", { name: "N" }, ctx);

    expect(repo.update).toHaveBeenCalledWith("ph-1", 7, { name: "N" }, tx);
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

    await service.update(actor, "ph-1", { name: "N" }, ctx);

    expect(order).toEqual(["lock", "read"]);
  });

  it("answers 404 when the phase is deleted between the lookup and the write", async () => {
    repo.update.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.update(actor, "ph-1", { name: "N" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
      message: "مرحلة الكهرباء غير موجودة",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.update.mockRejectedValue(new Error("connection lost"));

    await expect(service.update(actor, "ph-1", { name: "N" }, ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.update(actor, "ph-1", { name: "N" }, ctx)).rejects.toThrow("audit down");
  });

  describe("version", () => {
    it("refuses an If-Match that is not the current version: 409 with the current version, nothing written", async () => {
      repo.lockVersion.mockResolvedValue(4);

      const err = await failure(service.update(actor, "ph-1", { name: "N" }, ctxAr, 3));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ path: "version", value: 4 })]);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("accepts an If-Match that equals the current version", async () => {
      repo.lockVersion.mockResolvedValue(4);
      repo.findById.mockResolvedValue(row({ version: 4 }));

      await service.update(actor, "ph-1", { name: "N" }, ctx, 4);

      expect(repo.update).toHaveBeenCalledWith("ph-1", 4, { name: "N" }, tx);
    });

    it("does not insist on a version when the caller sent none", async () => {
      repo.lockVersion.mockResolvedValue(9);
      repo.findById.mockResolvedValue(row({ version: 9 }));

      await expect(service.update(actor, "ph-1", { name: "N" }, ctx)).resolves.toBeDefined();
    });

    it("answers 409 with the version it finds now when it loses the race for the row", async () => {
      repo.update.mockResolvedValue(null);
      repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const err = await failure(service.update(actor, "ph-1", { name: "N" }, ctx));

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

describe("reorder", () => {
  const three = () => [
    row({ id: "a", name: "A", sortOrder: 1, version: 1 }),
    row({ id: "b", name: "B", sortOrder: 2, version: 4 }),
    row({ id: "c", name: "C", sortOrder: 3, version: 2 }),
  ];

  beforeEach(() => {
    repo.lockAll.mockResolvedValue(three());
    repo.setSortOrder.mockImplementation(
      async (id: string, version: number, sortOrder: number) =>
        three().find((r) => r.id === id) && {
          ...three().find((r) => r.id === id)!,
          sortOrder,
          version: version + 1,
        },
    );
  });

  it("returns every phase in the new order, renumbered 1..n, with the moved ones on a new version", async () => {
    const result = await service.reorder(actor, { ids: ["c", "a", "b"] }, ctx);

    expect(result.map((p) => [p.id, p.sortOrder])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
    expect(result.map((p) => p.version)).toEqual([3, 2, 5]);
  });

  it("takes the order lock, then locks every phase, inside one transaction", async () => {
    const order: string[] = [];
    repo.lockOrder.mockImplementation(async () => void order.push("order"));
    repo.lockAll.mockImplementation(async () => {
      order.push("all");
      return three();
    });

    await service.reorder(actor, { ids: ["b", "a", "c"] }, ctx);

    expect(order).toEqual(["order", "all"]);
    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(repo.setSortOrder.mock.calls.every((call) => call[3] === tx)).toBe(true);
  });

  it("writes and audits only the phases that moved, each with its old and new place", async () => {
    await service.reorder(actor, { ids: ["a", "c", "b"] }, ctx);

    expect(repo.setSortOrder.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["c", 2, 2],
      ["b", 4, 3],
    ]);
    expect(auditCalls()).toHaveLength(2);
    expect(auditEntry(0)).toMatchObject({
      action: "elec_phase.reorder",
      entity: "ElecPhase",
      actorId: "admin-1",
      entityId: "c",
      before: { name: "C", status: "ACTIVE", sortOrder: 3 },
      after: { name: "C", status: "ACTIVE", sortOrder: 2 },
      requestId: "req-1",
    });
    expect(auditEntry(1)).toMatchObject({ entityId: "b", before: { sortOrder: 2 }, after: { sortOrder: 3 } });
    expect(auditCalls().every((call) => call[0] === tx)).toBe(true);
  });

  it("writes nothing and audits nothing when the order is already right", async () => {
    const result = await service.reorder(actor, { ids: ["a", "b", "c"] }, ctx);

    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(repo.setSortOrder).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("closes gaps: phases numbered 1, 3, 9 become 1, 2, 3", async () => {
    repo.lockAll.mockResolvedValue([
      row({ id: "a", sortOrder: 1 }),
      row({ id: "b", sortOrder: 3 }),
      row({ id: "c", sortOrder: 9 }),
    ]);

    const result = await service.reorder(actor, { ids: ["a", "b", "c"] }, ctx);

    expect(result.map((p) => p.sortOrder)).toEqual([1, 2, 3]);
    expect(repo.setSortOrder.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
  });

  it.each([
    ["leaves a phase out", ["a", "b"]],
    ["names a phase that does not exist", ["a", "b", "zzz"]],
    ["names a phase that does not exist instead of one that does", ["a", "b", "zzz", "c"]],
    ["swaps a real phase for an unknown one", ["a", "zzz", "c"]],
    ["repeats a phase and leaves another out", ["a", "a", "b"]],
    ["names every phase but repeats one", ["a", "a", "b", "c"]],
  ])("refuses a list that %s: 409 ELEC_PHASES_CHANGED, nothing written", async (_label, ids) => {
    const err = await failure(service.reorder(actor, { ids }, ctxAr));

    expect(err).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASES_CHANGED",
      message: "تغيرت قائمة مراحل الكهرباء. أعد تحميلها وحاول مرة أخرى",
    });
    expect(repo.setSortOrder).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 with the version it finds now when a phase moved under it", async () => {
    repo.setSortOrder.mockResolvedValue(null);
    repo.lockVersion.mockResolvedValue(9);

    const err = await failure(service.reorder(actor, { ids: ["b", "a", "c"] }, ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(err.details).toEqual([expect.objectContaining({ value: 9 })]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("fails as a whole when the audit write fails, so every move rolls back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.reorder(actor, { ids: ["b", "a", "c"] }, ctx)).rejects.toThrow("audit down");
  });
});

describe("remove", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(row());
  });

  it("answers 404 for an unknown phase and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.remove(actor, "x", ctx))).toMatchObject({ code: "ELEC_PHASE_NOT_FOUND" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("takes the order lock before the row lock (the same order as every writer of the phase set)", async () => {
    await service.remove(actor, "ph-1", ctx);

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
    expect(repo.lockOrder).toHaveBeenCalledWith(tx);
    expect(order(repo.lockOrder)).toBeLessThan(order(repo.lockVersion));
  });

  it("removes the rows still at 0 only after the usage check, and before the delete", async () => {
    await service.remove(actor, "ph-1", ctx);

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
    expect(repo.deleteZeroProgress).toHaveBeenCalledWith("ph-1", tx);
    expect(order(repo.countUsage)).toBeLessThan(order(repo.deleteZeroProgress));
    expect(order(repo.deleteZeroProgress)).toBeLessThan(order(repo.delete));
  });

  it("keeps the zero rows when the phase is in use", async () => {
    repo.countUsage.mockResolvedValue(1);

    await failure(service.remove(actor, "ph-1", ctx));

    expect(repo.deleteZeroProgress).not.toHaveBeenCalled();
  });

  it("answers 409 ELEC_PHASE_IN_USE when a villa moved the phase above 0 after the check (foreign key P2003)", async () => {
    repo.delete.mockRejectedValue(prismaError("P2003"));

    expect(await failure(service.remove(actor, "ph-1", ctx))).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_IN_USE",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("deletes an unused phase inside a transaction and audits the deleted values, with no `after`", async () => {
    await expect(service.remove(actor, "ph-1", ctx)).resolves.toBeUndefined();

    expect(repo.countUsage).toHaveBeenCalledWith("ph-1", tx);
    expect(repo.delete).toHaveBeenCalledWith("ph-1", 1, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "elec_phase.delete",
      entity: "ElecPhase",
      actorId: "admin-1",
      entityId: "ph-1",
      before: { name: "Ceiling Piping", status: "ACTIVE", sortOrder: 1 },
    });
    expect(auditEntry()?.after).toBeUndefined();
  });

  it.each([1, 2, 250])(
    "refuses a phase that %i records use: 409 ELEC_PHASE_IN_USE, nothing deleted or audited",
    async (uses) => {
      repo.countUsage.mockResolvedValue(uses);

      const err = await failure(service.remove(actor, "ph-1", ctxAr));

      expect(err).toMatchObject({
        statusCode: 409,
        code: "ELEC_PHASE_IN_USE",
        message:
          "هذه المرحلة مستخدمة (تقدم الفلل أو الأعمال المفتوحة) ولا يمكن حذفها. قم بتعطيلها بدلاً من ذلك",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("checks the version before it checks the usage", async () => {
    repo.lockVersion.mockResolvedValue(3);
    repo.findById.mockResolvedValue(row({ version: 3 }));
    repo.countUsage.mockResolvedValue(5);

    expect(await failure(service.remove(actor, "ph-1", ctx, 2))).toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(repo.countUsage).not.toHaveBeenCalled();
  });

  it("refuses a stale If-Match with 409 and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(3);
    repo.findById.mockResolvedValue(row({ version: 3 }));

    const err = await failure(service.remove(actor, "ph-1", ctx, 2));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(err.details).toEqual([expect.objectContaining({ value: 3 })]);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 409 when the row moved between the lock and the delete", async () => {
    repo.delete.mockResolvedValue(false);
    repo.lockVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const err = await failure(service.remove(actor, "ph-1", ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 404 when it was deleted by someone else after the check (P2025)", async () => {
    repo.delete.mockRejectedValue(prismaError("P2025"));

    expect(await failure(service.remove(actor, "ph-1", ctx))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
    });
  });

  it("lets other errors through unchanged", async () => {
    repo.delete.mockRejectedValue(new Error("connection lost"));

    await expect(service.remove(actor, "ph-1", ctx)).rejects.toThrow("connection lost");
  });

  it("fails as a whole when the audit write fails, so the delete can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.remove(actor, "ph-1", ctx)).rejects.toThrow("audit down");
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
    it("takes a trimmed name and an optional status", () => {
      expect(createElecPhaseSchema.parse({ name: "  Conduit  " })).toEqual({ name: "Conduit" });
      expect(createElecPhaseSchema.parse({ name: "N", status: "INACTIVE" })).toEqual({
        name: "N",
        status: "INACTIVE",
      });
    });

    it.each([
      [{}, "validation.required"],
      [{ name: "" }, "validation.nameRequired"],
      [{ name: "   " }, "validation.nameRequired"],
      [{ name: "x".repeat(101) }, "validation.nameTooLong"],
      [{ name: "N", status: "active" }, "validation.elecPhaseStatusInvalid"],
      [{ name: "N", status: "DONE" }, "validation.elecPhaseStatusInvalid"],
    ])("rejects %j with %s", (body, message) => {
      expect(issues(createElecPhaseSchema.safeParse(body))).toEqual([expect.objectContaining({ message })]);
    });

    it("rejects fields it does not know, so sortOrder and version cannot be set", () => {
      expect(createElecPhaseSchema.safeParse({ name: "N", sortOrder: 1 }).success).toBe(false);
      expect(createElecPhaseSchema.safeParse({ name: "N", version: 5 }).success).toBe(false);
      expect(createElecPhaseSchema.safeParse({ name: "N", id: "x" }).success).toBe(false);
    });
  });

  describe("update", () => {
    it("takes either field or both", () => {
      expect(updateElecPhaseSchema.safeParse({ name: "N" }).success).toBe(true);
      expect(updateElecPhaseSchema.safeParse({ status: "INACTIVE" }).success).toBe(true);
      expect(updateElecPhaseSchema.safeParse({ name: "N", status: "ACTIVE" }).success).toBe(true);
    });

    it("needs at least one field", () => {
      expect(issues(updateElecPhaseSchema.safeParse({}))).toEqual([
        expect.objectContaining({ message: "validation.atLeastOneField" }),
      ]);
    });

    it("cannot change the order, the version or the id", () => {
      expect(updateElecPhaseSchema.safeParse({ sortOrder: 2 }).success).toBe(false);
      expect(updateElecPhaseSchema.safeParse({ name: "N", version: 2 }).success).toBe(false);
    });

    it("rejects an unknown status", () => {
      expect(issues(updateElecPhaseSchema.safeParse({ status: "PAUSED" }))).toEqual([
        expect.objectContaining({ message: "validation.elecPhaseStatusInvalid" }),
      ]);
    });
  });

  describe("reorder", () => {
    const A = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";
    const B = "1c8f4d2f-6e63-4a1f-8b2e-7b4a3d0c8e22";

    it("takes a list of ids", () => {
      expect(reorderElecPhasesSchema.parse({ ids: [A, B] })).toEqual({ ids: [A, B] });
    });

    it.each([
      ["no ids", { ids: [] }],
      ["no list", {}],
      ["a list that is not an array", { ids: A }],
      ["a repeated id", { ids: [A, A] }],
      [
        "more than 1000 ids",
        { ids: Array.from({ length: 1001 }, (_, i) => `${i}`.padStart(8, "0") + A.slice(8)) },
      ],
    ])("rejects %s", (_label, body) => {
      expect(reorderElecPhasesSchema.safeParse(body).success).toBe(false);
    });

    it("reports a bad id as an invalid identifier", () => {
      expect(issues(reorderElecPhasesSchema.safeParse({ ids: [A, "nope"] }))).toEqual([
        { path: "ids.1", message: "validation.idInvalid" },
      ]);
    });

    it("reports a repeated id with the message that says each phase once", () => {
      expect(issues(reorderElecPhasesSchema.safeParse({ ids: [A, A] }))).toEqual([
        { path: "ids", message: "validation.elecPhaseIdsInvalid" },
      ]);
    });

    it("rejects fields it does not know", () => {
      expect(reorderElecPhasesSchema.safeParse({ ids: [A], extra: 1 }).success).toBe(false);
    });
  });

  describe("list query", () => {
    it("defaults the page and limit and takes an optional status", () => {
      expect(listElecPhasesQuerySchema.parse({})).toMatchObject({ page: 1, limit: 20 });
      expect(listElecPhasesQuerySchema.parse({ status: "ACTIVE" })).toMatchObject({ status: "ACTIVE" });
    });

    it("rejects an unknown status and an out-of-range page, never clamping", () => {
      expect(listElecPhasesQuerySchema.safeParse({ status: "active" }).success).toBe(false);
      expect(listElecPhasesQuerySchema.safeParse({ limit: "1001" }).success).toBe(false);
      expect(listElecPhasesQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    });
  });
});
