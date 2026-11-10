import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn(async () => undefined) },
}));

import { audit } from "../../../src/core/audit/audit.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import type { OpenWorksRepository } from "../../../src/modules/open-works/repository/open-works.repository.js";
import { OpenWorksService } from "../../../src/modules/open-works/service/open-works.service.js";
import {
  createOpenWorkSchema,
  listOpenWorksQuerySchema,
  updateOpenWorkSchema,
} from "../../../src/modules/open-works/validators/open-works.validators.js";

// The rules that the in-memory repository of the other tests cannot reach, because it behaves like the database does:
// a villa that is not there fails the foreign key, a version that moved is caught by the lock, and so on. Here the
// repository is a stub that answers what a real one would in the odd case, so the service's own guards are what is tested.
const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const actor: Actor = { id: "u1", role: "ADMIN" };
const uuid = "5f0c2b1e-8a43-4c3e-9d57-0b6f7a1c2d34";
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const item = (extra: Record<string, unknown> = {}) => ({
  id: "w1",
  elecPhaseId: "p1",
  status: "IN_PROGRESS",
  priority: "MEDIUM",
  progress: 10,
  contractorId: null,
  startDate: day("2026-10-10"),
  endDate: day("2026-10-20"),
  source: "MANUAL",
  version: 3,
  createdById: "u1",
  createdAt: day("2026-10-01"),
  updatedAt: day("2026-10-01"),
  villa: { id: "v1", villaNumber: "P-1", block: "B1", plot: "7", area: { name: "New Cairo" } },
  elecPhase: { id: "p1", name: "Wall piping" },
  contractor: null,
  createdBy: null,
  ...extra,
});

function stubRepository(overrides: Record<string, unknown> = {}) {
  const stub = {
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({})),
    findVillaId: vi.fn(async () => "v1"),
    lockVillaShared: vi.fn(async () => ({ contractorId: null })),
    lockVersion: vi.fn(async () => 3),
    findById: vi.fn(async () => item()),
    update: vi.fn(async () => item({ version: 4 })),
    delete: vi.fn(async () => true),
    create: vi.fn(async () => item()),
    elecPhaseStatus: vi.fn(async () => "ACTIVE"),
    contractorStatus: vi.fn(async () => "ACTIVE"),
    // The villa has no open work under the phase yet.
    lockVillaPhase: vi.fn(async () => undefined),
    findItemForPhase: vi.fn(async () => null),
    ...overrides,
  };
  return stub;
}
const serviceOf = (stub: ReturnType<typeof stubRepository>) =>
  new OpenWorksService(stub as unknown as OpenWorksRepository);

const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (err: unknown) => err,
  );

beforeEach(() => {
  vi.mocked(audit.record).mockClear();
});

describe("creating", () => {
  const input = { villaId: "v1", elecPhaseId: uuid };

  it("refuses a villa that is not there, before it writes anything", async () => {
    const stub = stubRepository({ lockVillaShared: vi.fn(async () => null) });

    expect(await rejection(serviceOf(stub).create(actor, input, ctx))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
    });
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("refuses a phase that is not there, before it writes anything", async () => {
    const stub = stubRepository({ elecPhaseStatus: vi.fn(async () => null) });

    expect(await rejection(serviceOf(stub).create(actor, input, ctx))).toMatchObject({
      statusCode: 404,
      code: "ELEC_PHASE_NOT_FOUND",
    });
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("refuses a phase that is switched off, before it writes anything", async () => {
    const stub = stubRepository({ elecPhaseStatus: vi.fn(async () => "INACTIVE") });

    expect(await rejection(serviceOf(stub).create(actor, input, ctx))).toMatchObject({
      statusCode: 409,
      code: "ELEC_PHASE_INACTIVE",
    });
    expect(stub.create).not.toHaveBeenCalled();
  });

  it("says the contractor is not on the villa before it says the contractor is inactive", async () => {
    const stub = stubRepository({
      lockVillaShared: vi.fn(async () => ({ contractorId: "other" })),
      contractorStatus: vi.fn(async () => "INACTIVE"),
    });

    expect(
      await rejection(serviceOf(stub).create(actor, { ...input, contractorId: uuid }, ctx)),
    ).toMatchObject({
      statusCode: 422,
      code: "CONTRACTOR_NOT_ON_VILLA",
    });
  });

  it.each([
    ["the villa", "WorkItem_villaId_fkey", 404, "VILLA_NOT_FOUND"],
    ["the phase", "WorkItem_elecPhaseId_fkey", 404, "ELEC_PHASE_NOT_FOUND"],
    ["the contractor", "WorkItem_contractorId_fkey", 404, "CONTRACTOR_NOT_FOUND"],
  ])(
    "answers a foreign key on %s that went missing at the last moment",
    async (_, constraint, status, code) => {
      const stub = stubRepository({
        create: vi.fn(async () => {
          throw Object.assign(new Error("fk"), { code: "P2003", meta: { target: constraint } });
        }),
      });

      expect(await rejection(serviceOf(stub).create(actor, input, ctx))).toMatchObject({
        statusCode: status,
        code,
      });
    },
  );
});

describe("updating and deleting", () => {
  it("refuses an item that is not there before it locks the villa", async () => {
    const stub = stubRepository({ findVillaId: vi.fn(async () => null) });

    expect(await rejection(serviceOf(stub).update(actor, "w1", { priority: "HIGH" }, ctx))).toMatchObject({
      statusCode: 404,
      code: "WORK_ITEM_NOT_FOUND",
    });
    expect(await rejection(serviceOf(stub).remove(actor, "w1", ctx))).toMatchObject({ statusCode: 404 });
    expect(stub.lockVillaShared).not.toHaveBeenCalled();
  });

  it("answers 409 when the row moved between the lock and the write", async () => {
    const stub = stubRepository({ update: vi.fn(async () => null) });

    expect(await rejection(serviceOf(stub).update(actor, "w1", { priority: "HIGH" }, ctx))).toMatchObject({
      statusCode: 409,
      code: "VERSION_CONFLICT",
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("allows an end date on the same day as the stored start date", async () => {
    const stub = stubRepository();

    await serviceOf(stub).update(actor, "w1", { endDate: day("2026-10-10") }, ctx);

    expect(stub.update).toHaveBeenCalled();
  });

  it("refuses an end date before the stored start date, and a start date after the stored end date", async () => {
    const stub = stubRepository();

    expect(
      await rejection(serviceOf(stub).update(actor, "w1", { endDate: day("2026-10-09") }, ctx)),
    ).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(
      await rejection(serviceOf(stub).update(actor, "w1", { startDate: day("2026-10-21") }, ctx)),
    ).toMatchObject({
      statusCode: 400,
    });
  });

  it("does not count a date the request clears: a later start is fine when the end goes away", async () => {
    const stub = stubRepository();

    await serviceOf(stub).update(actor, "w1", { startDate: day("2026-10-25"), endDate: null }, ctx);

    expect(stub.update).toHaveBeenCalled();
  });
});

describe("the request bodies and queries", () => {
  it("an update with a field it does not know is refused, whatever else it carries", () => {
    for (const extra of [
      { villaId: uuid },
      { source: "PHASE" },
      { id: uuid },
      { title: "x" },
      { phase: "MEP" },
    ]) {
      expect(updateOpenWorkSchema.safeParse({ priority: "HIGH", ...extra }).success).toBe(false);
    }
    expect(updateOpenWorkSchema.safeParse({ priority: "HIGH", elecPhaseId: uuid }).success).toBe(true);
    expect(
      createOpenWorkSchema.safeParse({ villaId: uuid, elecPhaseId: uuid, source: "PHASE" }).success,
    ).toBe(false);
    expect(createOpenWorkSchema.safeParse({ villaId: uuid, elecPhaseId: uuid, title: "x" }).success).toBe(
      false,
    );
    expect(createOpenWorkSchema.safeParse({ villaId: uuid }).success).toBe(false);
  });

  it("a list range may start and end on the same day", () => {
    expect(
      listOpenWorksQuerySchema.safeParse({ startFrom: "2026-10-05", startTo: "2026-10-05" }).success,
    ).toBe(true);
    expect(listOpenWorksQuerySchema.safeParse({ endFrom: "2026-10-05", endTo: "2026-10-05" }).success).toBe(
      true,
    );
    expect(
      listOpenWorksQuerySchema.safeParse({ startFrom: "2026-10-06", startTo: "2026-10-05" }).success,
    ).toBe(false);
    expect(listOpenWorksQuerySchema.safeParse({ endFrom: "2026-10-06", endTo: "2026-10-05" }).success).toBe(
      false,
    );
  });

  it("trims the search text", () => {
    expect(listOpenWorksQuerySchema.parse({ search: "  wall  " }).search).toBe("wall");
  });

  it("takes only true or false as overdue", () => {
    expect(listOpenWorksQuerySchema.parse({ overdue: "true" }).overdue).toBe(true);
    expect(listOpenWorksQuerySchema.parse({ overdue: "false" }).overdue).toBe(false);
    for (const bad of ["1", "0", "yes", "TRUE", ""]) {
      expect(listOpenWorksQuerySchema.safeParse({ overdue: bad }).success).toBe(false);
    }
  });
});

// The hooks are called with what the progress update and the villa update hand them. These call them directly with a
// repository stub, to pin what they do with states that the full flows cannot produce.
