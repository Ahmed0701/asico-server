import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import {
  VillaProgressService,
  progressChangeHooks,
  type ProgressChangeHook,
} from "../../../src/modules/villa-progress/service/villa-progress.service.js";
import type {
  Db,
  PhaseRow,
  ProgressRow,
  VillaProgressRepository,
} from "../../../src/modules/villa-progress/repository/villa-progress.repository.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const actor: Actor = { id: "admin-1", role: "ADMIN" };
const tx = { marker: "tx" } as unknown as Db;
const VILLA = "villa-1";
const PHASE = "phase-1";

const phase = (overrides: Partial<PhaseRow> = {}): PhaseRow => ({
  id: PHASE,
  name: "Ceiling Piping",
  sortOrder: 1,
  status: "ACTIVE",
  ...overrides,
});
const row = (overrides: Partial<ProgressRow> = {}): ProgressRow => ({
  villaId: VILLA,
  elecPhaseId: PHASE,
  progress: 0,
  completedAt: null,
  version: 1,
  ...overrides,
});

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    lockVilla: vi.fn(),
    lockPhase: vi.fn(),
    lockRow: vi.fn(),
    update: vi.fn(),
    totals: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let hook: ReturnType<typeof vi.fn<ProgressChangeHook>>;
let service: VillaProgressService;
const auditEntry = (index = 0) => vi.mocked(audit.record).mock.calls[index]?.[1];

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
  hook = vi.fn<ProgressChangeHook>();
  service = new VillaProgressService(repo as unknown as VillaProgressRepository, [hook]);
  repo.lockVilla.mockResolvedValue(true);
  repo.lockPhase.mockResolvedValue(phase());
  repo.lockRow.mockResolvedValue(row());
  repo.update.mockImplementation(
    async (_v: string, _p: string, version: number, data: { progress: number; completedAt: Date | null }) =>
      row({ ...data, version: version + 1 }),
  );
  // Two of the villa's six active phases are done, worth 20 and 15.
  repo.totals.mockResolvedValue({ doneRatio: 35, count: 6 });
});

describe("update", () => {
  it("checks the villa, then the phase, then locks the row, all in one transaction", async () => {
    await service.update(actor, VILLA, PHASE, { progress: 40 }, ctx);

    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(repo.lockVilla).toHaveBeenCalledWith(VILLA, tx);
    expect(repo.lockPhase).toHaveBeenCalledWith(PHASE, tx);
    expect(repo.lockRow).toHaveBeenCalledWith(VILLA, PHASE, tx);
    expect(repo.update).toHaveBeenCalledWith(VILLA, PHASE, 1, { progress: 40, completedAt: null }, tx);
  });

  it("answers the phase, its new version and the villa's overall progress over the active phases", async () => {
    const dto = await service.update(actor, VILLA, PHASE, { progress: 40 }, ctx);

    expect(dto).toEqual({
      elecPhaseId: PHASE,
      name: "Ceiling Piping",
      order: 1,
      progress: 40,
      state: "IN_PROGRESS",
      version: 2,
      villaProgress: 35,
      phaseCount: 6,
    });
    expect(repo.totals).toHaveBeenCalledWith(VILLA, tx);
  });

  it("answers 0 and phaseCount 0 when there is no active phase", async () => {
    repo.totals.mockResolvedValue({ doneRatio: 0, count: 0 });

    expect(await service.update(actor, VILLA, PHASE, { progress: 40 }, ctx)).toMatchObject({
      villaProgress: 0,
      phaseCount: 0,
    });
  });

  it("answers 404 VILLA_NOT_FOUND before it looks at the phase", async () => {
    repo.lockVilla.mockResolvedValue(false);

    expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
      message: "الفيلا غير موجودة",
    });
    expect(repo.lockPhase).not.toHaveBeenCalled();
    expect(repo.lockRow).not.toHaveBeenCalled();
  });

  it("answers 404 ELEC_PHASE_NOT_FOUND for an unknown phase", async () => {
    repo.lockPhase.mockResolvedValue(null);

    expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
    });
    expect(repo.lockRow).not.toHaveBeenCalled();
  });

  it("answers 409 ELEC_PHASE_INACTIVE for an inactive phase, translated, before it locks or writes anything", async () => {
    repo.lockPhase.mockResolvedValue(phase({ status: "INACTIVE" }));

    expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctxAr))).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_INACTIVE",
      message: "هذه المرحلة معطلة، لذلك لا يمكن تغيير نسبة الإنجاز فيها",
    });
    expect(repo.lockRow).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  describe("completion", () => {
    it("100 sets completedAt to now", async () => {
      const before = Date.now();

      await service.update(actor, VILLA, PHASE, { progress: 100 }, ctx);

      const data = repo.update.mock.calls[0]?.[3];
      expect(data.progress).toBe(100);
      expect(data.completedAt).toBeInstanceOf(Date);
      expect(data.completedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("anything below 100 clears it", async () => {
      repo.lockRow.mockResolvedValue(row({ progress: 100, completedAt: new Date("2026-01-01T00:00:00Z") }));

      await service.update(actor, VILLA, PHASE, { progress: 99 }, ctx);

      expect(repo.update.mock.calls[0]?.[3]).toEqual({ progress: 99, completedAt: null });
    });

    it("0 clears it too", async () => {
      repo.lockRow.mockResolvedValue(row({ progress: 100, completedAt: new Date("2026-01-01T00:00:00Z") }));

      await service.update(actor, VILLA, PHASE, { progress: 0 }, ctx);

      expect(repo.update.mock.calls[0]?.[3]).toEqual({ progress: 0, completedAt: null });
    });
  });

  describe("versions", () => {
    it("refuses a stale If-Match with 409 VERSION_CONFLICT carrying the current version, and writes nothing", async () => {
      repo.lockRow.mockResolvedValue(row({ version: 5 }));

      const err = await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx, 4));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ path: "version", value: 5 })]);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
    });

    it("writes against the version it locked", async () => {
      repo.lockRow.mockResolvedValue(row({ version: 5 }));

      await service.update(actor, VILLA, PHASE, { progress: 5 }, ctx, 5);

      expect(repo.update.mock.calls[0]?.[2]).toBe(5);
    });

    it("answers 409 when the row moved between the lock and the write", async () => {
      repo.lockRow.mockResolvedValueOnce(row({ version: 1 })).mockResolvedValueOnce(row({ version: 2 }));
      repo.update.mockResolvedValue(null);

      const err = await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx));

      expect(err).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect(err.details).toEqual([expect.objectContaining({ value: 2 })]);
      expect(audit.record).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe("setting what is already there", () => {
    beforeEach(() => {
      repo.lockRow.mockResolvedValue(row({ progress: 30, version: 4 }));
    });

    it("writes nothing, audits nothing, runs no hook, and answers with the current version", async () => {
      const dto = await service.update(actor, VILLA, PHASE, { progress: 30 }, ctx);

      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(dto).toMatchObject({ progress: 30, version: 4 });
    });

    it("still refuses a stale If-Match", async () => {
      expect(await failure(service.update(actor, VILLA, PHASE, { progress: 30 }, ctx, 3))).toMatchObject({
        code: "VERSION_CONFLICT",
      });
    });
  });

  describe("the audit entry", () => {
    it("is written once, in the transaction, as the actor, with before and after", async () => {
      repo.lockRow.mockResolvedValue(row({ progress: 10 }));

      await service.update(actor, VILLA, PHASE, { progress: 60 }, ctx);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(vi.mocked(audit.record).mock.calls[0]?.[0]).toBe(tx);
      expect(auditEntry()).toMatchObject({
        actorId: "admin-1",
        action: "villa.progress",
        entity: "Villa",
        entityId: VILLA,
        before: { elecPhaseId: PHASE, phase: "Ceiling Piping", progress: 10 },
        after: { elecPhaseId: PHASE, phase: "Ceiling Piping", progress: 60 },
        ip: "203.0.113.5",
        userAgent: "vitest",
        requestId: "req-1",
      });
    });

    it("fails the whole update when the audit write fails, so the transaction can roll back", async () => {
      vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

      await expect(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx)).rejects.toThrow("audit down");
    });
  });

  describe("write errors", () => {
    const foreignKey = (constraint: string): Error =>
      Object.assign(new Error("Prisma P2003"), {
        code: "P2003",
        meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
      });

    it("maps a villa deleted after the check to 404 VILLA_NOT_FOUND", async () => {
      repo.lockRow.mockRejectedValue(foreignKey("VillaPhaseProgress_villaId_fkey"));

      expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx))).toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("maps a phase deleted after the check to 404 ELEC_PHASE_NOT_FOUND", async () => {
      repo.lockRow.mockRejectedValue(foreignKey("VillaPhaseProgress_elecPhaseId_fkey"));

      expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx))).toMatchObject({
        statusCode: 404,
        code: "ELEC_PHASE_NOT_FOUND",
      });
    });

    it("maps P2025 to 404 VILLA_NOT_FOUND", async () => {
      repo.update.mockRejectedValue(Object.assign(new Error("Prisma P2025"), { code: "P2025" }));

      expect(await failure(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx))).toMatchObject({
        code: "VILLA_NOT_FOUND",
      });
    });

    it("lets other errors through unchanged", async () => {
      repo.update.mockRejectedValue(new Error("connection lost"));

      await expect(service.update(actor, VILLA, PHASE, { progress: 5 }, ctx)).rejects.toThrow(
        "connection lost",
      );
    });
  });
});

// The contract the open works (slice 9) rely on. Nothing is registered yet.
describe("the progress-change hook (slice 9)", () => {
  it("has nothing registered yet", () => {
    expect(progressChangeHooks).toEqual([]);
  });

  it("is called once per change, inside the transaction, with the change", async () => {
    repo.lockRow.mockResolvedValue(row({ progress: 40 }));

    await service.update(actor, VILLA, PHASE, { progress: 100 }, ctx);

    expect(hook).toHaveBeenCalledTimes(1);
    const [client, change] = hook.mock.calls[0]!;
    expect(client).toBe(tx);
    expect(change).toMatchObject({
      villaId: VILLA,
      phase: { id: PHASE, name: "Ceiling Piping", sortOrder: 1, status: "ACTIVE" },
      before: { progress: 40, completedAt: null },
      after: { progress: 100 },
      actor,
      ctx,
    });
    expect(change.after.completedAt).toBeInstanceOf(Date);
  });

  it("runs after the row is written and before the audit entry", async () => {
    await service.update(actor, VILLA, PHASE, { progress: 100 }, ctx);

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
    expect(order(repo.update)).toBeLessThan(order(hook));
    expect(order(hook)).toBeLessThan(order(vi.mocked(audit.record)));
  });

  it("runs every hook in the order they were registered", async () => {
    const calls: string[] = [];
    const a: ProgressChangeHook = async () => void calls.push("a");
    const b: ProgressChangeHook = async () => void calls.push("b");
    service = new VillaProgressService(repo as unknown as VillaProgressRepository, [a, b]);

    await service.update(actor, VILLA, PHASE, { progress: 100 }, ctx);

    expect(calls).toEqual(["a", "b"]);
  });

  it("is not called when the update is refused (no villa, no phase, inactive phase, stale version)", async () => {
    repo.lockVilla.mockResolvedValueOnce(false);
    await failure(service.update(actor, VILLA, PHASE, { progress: 100 }, ctx));
    repo.lockPhase.mockResolvedValueOnce(null);
    await failure(service.update(actor, VILLA, PHASE, { progress: 100 }, ctx));
    repo.lockPhase.mockResolvedValueOnce(phase({ status: "INACTIVE" }));
    await failure(service.update(actor, VILLA, PHASE, { progress: 100 }, ctx));
    await failure(service.update(actor, VILLA, PHASE, { progress: 100 }, ctx, 9));

    expect(hook).not.toHaveBeenCalled();
  });

  it("is not called when nothing changed", async () => {
    repo.lockRow.mockResolvedValue(row({ progress: 100, completedAt: new Date() }));

    await service.update(actor, VILLA, PHASE, { progress: 100 }, ctx);

    expect(hook).not.toHaveBeenCalled();
  });

  it("makes the whole update fail when it throws, so the transaction rolls back (no audit entry)", async () => {
    hook.mockRejectedValue(new Error("hook failed"));

    await expect(service.update(actor, VILLA, PHASE, { progress: 100 }, ctx)).rejects.toThrow("hook failed");

    expect(audit.record).not.toHaveBeenCalled();
  });
});
