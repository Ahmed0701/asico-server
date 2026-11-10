import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import type {
  Db,
  VillaDetailRow,
  VillaListRow,
  VillaSnapshotRow,
  VillasRepository,
} from "../../../src/modules/villas/repository/villas.repository.js";
import type { ContractorChangeHook } from "../../../src/modules/villas/service/villa-hooks.js";
import { VillasService } from "../../../src/modules/villas/service/villas.service.js";
import {
  createVillaSchema,
  listVillasQuerySchema,
  updateVillaSchema,
  type CreateVillaInput,
  type ListVillasQuery,
  type UpdateVillaInput,
} from "../../../src/modules/villas/validators/villas.validators.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

vi.mock("../../../src/modules/villa-documents/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villa-documents/index.js")>()),
  removeVillaDocuments: vi.fn(),
}));
import { removeVillaDocuments } from "../../../src/modules/villa-documents/index.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const actor: Actor = { id: "admin-1", role: "ADMIN" };
// The count of the open works typed in for the villa, which a delete refuses on (0 unless a test says otherwise).
const manualItems = vi.fn<(args: unknown) => Promise<number>>();
// The same for the daily reports of the villa.
const reports = vi.fn<(args: unknown) => Promise<number>>();
// And for its daily small works.
const smallWorks = vi.fn<(args: unknown) => Promise<number>>();
// And for its site reports.
const siteReports = vi.fn<(args: unknown) => Promise<number>>();
// And for its daily labour.
const labour = vi.fn<(args: unknown) => Promise<number>>();
// And for its material deliveries.
const deliveries = vi.fn<(args: unknown) => Promise<number>>();
const tx = {
  marker: "tx",
  workItem: { count: manualItems },
  dailyReport: { count: reports },
  dailySmallWork: { count: smallWorks },
  siteReport: { count: siteReports },
  dailyLabour: { count: labour },
  materialDelivery: { count: deliveries },
} as unknown as Db;

const ENG = "11111111-1111-4111-8111-111111111111";
const ENG2 = "22222222-2222-4222-8222-222222222222";
const [ELEC_A, ELEC_B] = ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"];
const [CON_A, CON_B] = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
const AREA = "44444444-4444-4444-8444-444444444444";
const AREA2 = "55555555-5555-4555-8555-555555555555";
const CREATED = new Date("2026-03-04T05:06:07.890Z");
const UPDATED = new Date("2026-03-05T05:06:07.890Z");

function listRow(overrides: Partial<VillaListRow> = {}): VillaListRow {
  return {
    id: "villa-1",
    villaNumber: "P-001",
    ownerName: null,
    villaType: null,
    areaId: AREA,
    area: { name: "New Cairo" },
    block: "B1",
    plot: "12",
    startDate: null,
    targetDate: null,
    budgetMinor: null,
    currency: null,
    mewFollowUpAt: null,
    mewFollowUpBy: null,
    mewInspectionAt: null,
    mewInspectionBy: null,
    mewInspectionPassedAt: null,
    mewInspectionPassedBy: null,
    mewAcState: "NOT_SUBMITTED",
    mewElecState: "NOT_SUBMITTED",
    mewInspectionDate: null,
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    civilEngineer: { id: ENG, name: "Mona Hassan" },
    electricalEngineer: null,
    contractor: null,
    doneRatio: 0,
    phaseCount: 0,
    ...overrides,
  };
}

function snapshotRow(overrides: Partial<VillaSnapshotRow> = {}): VillaSnapshotRow {
  return {
    villaNumber: "P-001",
    ownerName: null,
    villaType: null,
    areaId: AREA,
    block: "B1",
    plot: "12",
    civilEngineerId: ENG,
    electricalEngineerId: null,
    contractorId: CON_A,
    startDate: new Date("2026-01-05T00:00:00.000Z"),
    targetDate: new Date("2026-03-01T00:00:00.000Z"),
    budgetMinor: null,
    currency: null,
    ...overrides,
  };
}

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    list: vi.fn(),
    options: vi.fn(),
    filterOptions: vi.fn(),
    findDetail: vi.fn(),
    findListRow: vi.fn(),
    findSnapshot: vi.fn(),
    areaExists: vi.fn(),
    civilEngineerStatus: vi.fn(),
    electricalEngineerStatus: vi.fn(),
    contractorStatus: vi.fn(),
    create: vi.fn(),
    lockPhaseSet: vi.fn(),
    insertProgressRows: vi.fn(),
    progressTotals: vi.fn(),
    updateScalars: vi.fn(),
    lockVersion: vi.fn(),
    delete: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let service: VillasService;
const auditCalls = () => vi.mocked(audit.record).mock.calls;
const auditEntry = (index = 0) => auditCalls()[index]?.[1];

// Errors shaped like the real ones: the constraint name sits under meta.driverAdapterError.cause.constraint.
const dbError = (code: string, constraint?: string): Error =>
  Object.assign(new Error(`Prisma ${code}`), {
    code,
    ...(constraint && { meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } } }),
  });

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
  vi.mocked(removeVillaDocuments).mockReset();
  manualItems.mockReset();
  manualItems.mockResolvedValue(0);
  reports.mockReset();
  reports.mockResolvedValue(0);
  smallWorks.mockReset();
  smallWorks.mockResolvedValue(0);
  siteReports.mockReset();
  siteReports.mockResolvedValue(0);
  labour.mockReset();
  labour.mockResolvedValue(0);
  deliveries.mockReset();
  deliveries.mockResolvedValue(0);
  repo = makeRepo();
  repo.lockVersion.mockResolvedValue(1);
  repo.updateScalars.mockResolvedValue(true);
  repo.delete.mockResolvedValue(true);
  service = new VillasService(repo as unknown as VillasRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListVillasQuery> = {}): ListVillasQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("defaults to location order, page 1, 20 per page, with no filters", async () => {
    repo.list.mockResolvedValue({ rows: [listRow(), listRow({ id: "p2" })], total: 45 });

    const result = await service.list(query());

    const call = repo.list.mock.calls[0]?.[0];
    expect(call).toMatchObject({ sort: { field: "location", direction: "asc" }, skip: 0, take: 20 });
    expect(Object.values(call.filters).every((value) => value === undefined)).toBe(true);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
  });

  it("maps a row to the documented item shape", async () => {
    repo.list.mockResolvedValue({
      rows: [
        listRow({
          ownerName: "Hala Samir",
          startDate: new Date("2026-01-05T00:00:00.000Z"),
          contractor: { id: CON_A, name: "Nile Builders" },
          electricalEngineer: { id: ELEC_A, name: "Karim Adel" },
          budgetMinor: 125050n,
          currency: "EGP",
        }),
      ],
      total: 1,
    });

    const [item] = (await service.list(query())).items;

    expect(item).toEqual({
      id: "villa-1",
      villaNumber: "P-001",
      ownerName: "Hala Samir",
      villaType: null,
      area: "New Cairo",
      areaId: AREA,
      block: "B1",
      plot: "12",
      location: "New Cairo . B1 . 12",
      civilEngineer: { id: ENG, name: "Mona Hassan" },
      electricalEngineer: { id: ELEC_A, name: "Karim Adel" },
      contractor: { id: CON_A, name: "Nile Builders" },
      startDate: "2026-01-05",
      targetDate: null,
      budgetMinor: 125050,
      currency: "EGP",
      progress: 0,
      mewFollowUp: null,
      mewInspection: null,
      mewInspectionPassed: null,
      mewAcState: "NOT_SUBMITTED",
      mewElecState: "NOT_SUBMITTED",
      mewInspectionDate: null,
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-05T05:06:07.890Z",
    });
  });

  it("shows a villa with no owner, electrical engineer or budget as nulls", async () => {
    repo.list.mockResolvedValue({ rows: [listRow()], total: 1 });

    expect((await service.list(query())).items[0]).toMatchObject({
      ownerName: null,
      villaType: null,
      electricalEngineer: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("writes the location as 'area . block . plot' with the exact spaces and dots", async () => {
    repo.list.mockResolvedValue({
      rows: [listRow({ area: { name: "Sheikh Zayed" }, block: "C 3", plot: "A-10" })],
      total: 1,
    });

    expect((await service.list(query())).items[0]?.location).toBe("Sheikh Zayed . C 3 . A-10");
  });

  it("returns the budget as a JSON number, exact up to the largest the API accepts", async () => {
    repo.list.mockResolvedValue({
      rows: [listRow({ budgetMinor: BigInt(Number.MAX_SAFE_INTEGER), currency: "USD" })],
      total: 1,
    });

    const [item] = (await service.list(query())).items;

    expect(item?.budgetMinor).toBe(9007199254740991);
    expect(typeof item?.budgetMinor).toBe("number");
    expect(() => JSON.stringify(item)).not.toThrow();
  });

  it("maps a villa with no contractor to contractor null", async () => {
    repo.list.mockResolvedValue({ rows: [listRow()], total: 1 });

    expect((await service.list(query())).items[0]?.contractor).toBeNull();
  });

  it("passes every filter and the page window through", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });
    const day = new Date("2026-01-01T00:00:00.000Z");

    await service.list(
      query({
        area: "Area",
        areaId: AREA,
        block: "B",
        plot: "7",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
        startFrom: day,
        startTo: day,
        targetFrom: day,
        targetTo: day,
        search: "nile",
        page: 3,
        limit: 50,
      }),
    );

    expect(repo.list.mock.calls[0]?.[0]).toEqual({
      filters: {
        area: "Area",
        areaId: AREA,
        block: "B",
        plot: "7",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
        startFrom: day,
        startTo: day,
        targetFrom: day,
        targetTo: day,
        search: "nile",
      },
      sort: { field: "location", direction: "asc" },
      skip: 100,
      take: 50,
    });
  });

  it.each([
    ["location", "location", "asc"],
    ["location:desc", "location", "desc"],
    ["villaNumber", "villaNumber", "asc"],
    ["targetDate:desc", "targetDate", "desc"],
    ["progress", "progress", "asc"],
    ["progress:desc", "progress", "desc"],
    ["createdAt", "createdAt", "asc"],
    ["createdAt:desc", "createdAt", "desc"],
    ["area:desc", "location", "asc"],
    ["block", "location", "asc"],
    ["plot:asc", "location", "asc"],
    ["startDate", "location", "asc"],
    ["civilEngineer:asc", "location", "asc"],
    ["status:desc", "location", "asc"],
  ])(
    "maps sort %j to %s %s, falling back to the default (location asc) off the whitelist",
    async (sort, field, direction) => {
      repo.list.mockResolvedValue({ rows: [], total: 0 });

      await service.list(query({ sort }));

      expect(repo.list.mock.calls[0]?.[0].sort).toEqual({ field, direction });
    },
  );
});

describe("progress in the answers", () => {
  it.each([
    [0, 0, 0],
    [0, 6, 0],
    [30, 6, 30],
    [100, 6, 100],
    // Ratios that add up to more than 100 never take a villa past it.
    [130, 6, 100],
  ])(
    "shows what the done phases add up to (%i over %i active phases) as %f",
    async (doneRatio, phaseCount, progress) => {
      repo.list.mockResolvedValue({ rows: [listRow({ doneRatio, phaseCount })], total: 1 });

      const result = await service.list(query());

      expect(result.items[0]?.progress).toBe(progress);
    },
  );

  it("shows 0 for a villa with no active phase, never NaN", async () => {
    repo.list.mockResolvedValue({ rows: [listRow({ doneRatio: 0, phaseCount: 0 })], total: 1 });

    expect((await service.list(query())).items[0]?.progress).toBe(0);
  });

  it("shows the phases of the detail in the order given, with the state, the order and the version", async () => {
    repo.findDetail.mockResolvedValue({
      ...listRow({ doneRatio: 50, phaseCount: 3 }),
      civilEngineer: { id: ENG, name: "Mona Hassan", phone: "0100 123 4567" },
      electricalEngineer: null,
      contractor: null,
      createdBy: { id: "u1", name: "Root Admin" },
      phases: [
        {
          elecPhaseId: "p1",
          name: "Ceiling Piping",
          sortOrder: 1,
          progressRatio: 50,
          progress: 100,
          version: 3,
        },
        { elecPhaseId: "p2", name: "Sleeves", sortOrder: 2, progressRatio: 30, progress: 50, version: 2 },
        { elecPhaseId: "p3", name: "Wall Piping", sortOrder: 5, progressRatio: 20, progress: 0, version: 1 },
      ],
    });

    const dto = await service.get("villa-1", ctx);

    expect(dto).toMatchObject({ progress: 50, phaseCount: 3 });
    expect(dto.phases).toEqual([
      { elecPhaseId: "p1", name: "Ceiling Piping", order: 1, progress: 100, state: "DONE", version: 3 },
      { elecPhaseId: "p2", name: "Sleeves", order: 2, progress: 50, state: "IN_PROGRESS", version: 2 },
      { elecPhaseId: "p3", name: "Wall Piping", order: 5, progress: 0, state: "NOT_STARTED", version: 1 },
    ]);
  });
});

describe("options and filters", () => {
  it("pass through what the repository found", async () => {
    repo.options.mockResolvedValue([{ id: "1", villaNumber: "P-1" }]);
    repo.filterOptions.mockResolvedValue({
      areas: ["A"],
      blocks: ["B"],
      civilEngineers: [{ id: "c1", name: "Mona" }],
      electricalEngineers: [],
    });

    await expect(service.options()).resolves.toEqual([{ id: "1", villaNumber: "P-1" }]);
    await expect(service.filters()).resolves.toEqual({
      areas: ["A"],
      blocks: ["B"],
      civilEngineers: [{ id: "c1", name: "Mona" }],
      electricalEngineers: [],
    });
  });
});

describe("get", () => {
  it("answers 404 VILLA_NOT_FOUND, translated", async () => {
    repo.findDetail.mockResolvedValue(null);

    expect(await failure(service.get("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
      message: "الفيلا غير موجودة",
    });
  });

  it("returns the full record: both engineers and the contractor with phones, the owner, the budget and the creator", async () => {
    const detail: VillaDetailRow = {
      ...listRow({ ownerName: "Hala Samir", budgetMinor: 500n, currency: "USD" }),
      civilEngineer: { id: ENG, name: "Mona Hassan", phone: "0100 123 4567" },
      electricalEngineer: { id: ELEC_A, name: "Karim Adel", phone: "0102 222 3333" },
      contractor: { id: CON_A, name: "Nile", phone: "0101 000 0000" },
      createdBy: { id: "u1", name: "Root Admin" },
      phases: [],
    };
    repo.findDetail.mockResolvedValue(detail);

    const dto = await service.get("villa-1", ctx);

    expect(dto).toMatchObject({
      ownerName: "Hala Samir",
      location: "New Cairo . B1 . 12",
      civilEngineer: { id: ENG, name: "Mona Hassan", phone: "0100 123 4567" },
      electricalEngineer: { id: ELEC_A, name: "Karim Adel", phone: "0102 222 3333" },
      contractor: { id: CON_A, name: "Nile", phone: "0101 000 0000" },
      budgetMinor: 500,
      currency: "USD",
      createdBy: { id: "u1", name: "Root Admin" },
    });
    for (const key of ["activities", "contractors", "files", "status"]) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  it("returns contractor and electrical engineer null for a villa without them", async () => {
    repo.findDetail.mockResolvedValue({
      ...listRow(),
      civilEngineer: { id: ENG, name: "Mona Hassan", phone: "0100 123 4567" },
      electricalEngineer: null,
      contractor: null,
      createdBy: { id: "u1", name: "Root Admin" },
      phases: [],
    });

    const dto = await service.get("villa-1", ctx);

    expect(dto.contractor).toBeNull();
    expect(dto.electricalEngineer).toBeNull();
  });
});

describe("create", () => {
  const input = (overrides: Partial<CreateVillaInput> = {}): CreateVillaInput => ({
    villaNumber: "P-001",
    areaId: AREA,
    block: "B1",
    plot: "12",
    civilEngineerId: ENG,
    ...overrides,
  });

  beforeEach(() => {
    repo.areaExists.mockResolvedValue(true);
    repo.civilEngineerStatus.mockResolvedValue("ACTIVE");
    repo.electricalEngineerStatus.mockResolvedValue("ACTIVE");
    repo.contractorStatus.mockResolvedValue("ACTIVE");
    repo.create.mockResolvedValue(listRow({ id: "new-villa", contractor: { id: CON_B, name: "B" } }));
  });

  it("answers 404 AREA_NOT_FOUND for an unknown area, translated, before any write", async () => {
    repo.areaExists.mockResolvedValue(false);

    expect(await failure(service.create(actor, input(), ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
      message: "المنطقة غير موجودة",
    });
    expect(repo.areaExists).toHaveBeenCalledWith(AREA);
    expect(repo.transaction).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("answers 404 CIVIL_ENGINEER_NOT_FOUND for an unknown engineer, before any write", async () => {
    repo.civilEngineerStatus.mockResolvedValue(null);

    expect(await failure(service.create(actor, input(), ctxAr))).toMatchObject({
      statusCode: 404,
      code: "CIVIL_ENGINEER_NOT_FOUND",
      message: "المهندس المدني غير موجود",
    });
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND for an unknown electrical engineer, before any write", async () => {
    repo.electricalEngineerStatus.mockResolvedValue(null);

    expect(
      await failure(service.create(actor, input({ electricalEngineerId: ELEC_A }), ctxAr)),
    ).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
      message: "مهندس الكهرباء غير موجود",
    });
    expect(repo.electricalEngineerStatus).toHaveBeenCalledWith(ELEC_A);
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  describe("an inactive party is refused", () => {
    it("answers 400 CIVIL_ENGINEER_INACTIVE, translated, before any write", async () => {
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");

      expect(await failure(service.create(actor, input(), ctxAr))).toMatchObject({
        statusCode: 400,
        code: "CIVIL_ENGINEER_INACTIVE",
        message: "هذا المهندس المدني غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(repo.transaction).not.toHaveBeenCalled();
    });

    it("answers 400 ELECTRICAL_ENGINEER_INACTIVE, translated, before any write", async () => {
      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");

      expect(
        await failure(service.create(actor, input({ electricalEngineerId: ELEC_A }), ctxAr)),
      ).toMatchObject({
        statusCode: 400,
        code: "ELECTRICAL_ENGINEER_INACTIVE",
        message: "مهندس الكهرباء هذا غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(repo.transaction).not.toHaveBeenCalled();
    });

    it("answers 400 CONTRACTOR_INACTIVE, translated, before any write", async () => {
      repo.contractorStatus.mockResolvedValue("INACTIVE");

      expect(await failure(service.create(actor, input({ contractorId: CON_A }), ctxAr))).toMatchObject({
        statusCode: 400,
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على فيلا",
      });
      expect(repo.transaction).not.toHaveBeenCalled();
    });

    it("says it in English too", async () => {
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");

      expect(await failure(service.create(actor, input(), ctx))).toMatchObject({
        message: "This civil engineer is inactive and cannot be assigned to a villa",
      });
    });

    it("checks the civil engineer before the electrical engineer before the contractor", async () => {
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");
      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");
      repo.contractorStatus.mockResolvedValue("INACTIVE");
      const all = input({ electricalEngineerId: ELEC_A, contractorId: CON_A });

      expect(await failure(service.create(actor, all, ctx))).toMatchObject({
        code: "CIVIL_ENGINEER_INACTIVE",
      });
      repo.civilEngineerStatus.mockResolvedValue("ACTIVE");
      expect(await failure(service.create(actor, all, ctx))).toMatchObject({
        code: "ELECTRICAL_ENGINEER_INACTIVE",
      });
      repo.electricalEngineerStatus.mockResolvedValue("ACTIVE");
      expect(await failure(service.create(actor, all, ctx))).toMatchObject({ code: "CONTRACTOR_INACTIVE" });
    });
  });

  it("answers 404 CONTRACTOR_NOT_FOUND for an unknown contractor, before any write", async () => {
    repo.contractorStatus.mockResolvedValue(null);

    expect(await failure(service.create(actor, input({ contractorId: CON_A }), ctxAr))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
      message: "المقاول غير موجود",
    });
    expect(repo.contractorStatus).toHaveBeenCalledWith(CON_A);
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it("does not look a contractor or an electrical engineer up when none is given, or when it is null", async () => {
    await service.create(actor, input(), ctx);
    await service.create(actor, input({ contractorId: null, electricalEngineerId: null }), ctx);

    expect(repo.contractorStatus).not.toHaveBeenCalled();
    expect(repo.electricalEngineerStatus).not.toHaveBeenCalled();
    expect(repo.create.mock.calls.map((call) => call[0].contractorId)).toEqual([null, null]);
    expect(repo.create.mock.calls.map((call) => call[0].electricalEngineerId)).toEqual([null, null]);
  });

  it("creates the villa and its audit row in one transaction, owned by the caller", async () => {
    const dto = await service.create(
      actor,
      input({
        contractorId: CON_A,
        ownerName: "Hala Samir",
        electricalEngineerId: ELEC_A,
        startDate: new Date("2026-01-05T00:00:00.000Z"),
      }),
      ctx,
    );

    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      {
        villaNumber: "P-001",
        ownerName: "Hala Samir",
        villaType: null,
        areaId: AREA,
        block: "B1",
        plot: "12",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
        createdById: "admin-1",
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        targetDate: null,
        budgetMinor: null,
        currency: null,
      },
      tx,
    );
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(dto).toMatchObject({ id: "new-villa", contractor: { id: CON_B, name: "B" } });
    expect(dto).not.toHaveProperty("createdBy");
    expect(JSON.stringify(dto)).not.toMatch(/phone/);
  });

  describe("progress rows", () => {
    it("takes the phase-set lock, creates the villa, then inserts its rows, all in the transaction and before the audit entry", async () => {
      await service.create(actor, input(), ctx);

      expect(repo.lockPhaseSet).toHaveBeenCalledWith(tx);
      expect(repo.insertProgressRows).toHaveBeenCalledWith("new-villa", tx);
      const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
      expect(order(repo.lockPhaseSet)).toBeLessThan(order(repo.create));
      expect(order(repo.create)).toBeLessThan(order(repo.insertProgressRows));
      expect(order(repo.insertProgressRows)).toBeLessThan(order(vi.mocked(audit.record)));
    });

    it("does not lock or insert when a check fails before the transaction", async () => {
      repo.areaExists.mockResolvedValue(false);

      await failure(service.create(actor, input(), ctx));

      expect(repo.lockPhaseSet).not.toHaveBeenCalled();
      expect(repo.insertProgressRows).not.toHaveBeenCalled();
    });

    it("fails the whole create, with no audit entry, when the rows cannot be inserted", async () => {
      repo.insertProgressRows.mockRejectedValue(new Error("boom"));

      await expect(service.create(actor, input(), ctx)).rejects.toThrow("boom");

      expect(auditCalls()).toHaveLength(0);
    });

    it("answers the new villa's progress: 0, over the active phases", async () => {
      repo.create.mockResolvedValue(listRow({ id: "new-villa", doneRatio: 0, phaseCount: 6 }));

      expect(await service.create(actor, input(), ctx)).toMatchObject({ progress: 0 });
    });
  });

  describe("budget", () => {
    it("stores no budget and no currency when neither is sent", async () => {
      await service.create(actor, input(), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: null, currency: null });
    });

    it("gives a budget without a currency the default KWD", async () => {
      await service.create(actor, input({ budgetMinor: 125050 }), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: 125050, currency: "KWD" });
    });

    it.each(["EGP", "KWD", "JPY"])("keeps %s when it is sent, whatever the default is", async (code) => {
      await service.create(actor, input({ budgetMinor: 125050, currency: code }), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: 125050, currency: code });
    });

    it("keeps the currency that was sent", async () => {
      await service.create(actor, input({ budgetMinor: 5, currency: "USD" }), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: 5, currency: "USD" });
    });

    it("accepts a budget of zero (a zero budget is still a budget, and keeps its currency)", async () => {
      await service.create(actor, input({ budgetMinor: 0 }), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: 0, currency: "KWD" });
    });

    it("treats an explicit null budget as no budget", async () => {
      await service.create(actor, input({ budgetMinor: null }), ctx);

      expect(repo.create.mock.calls[0]?.[0]).toMatchObject({ budgetMinor: null, currency: null });
    });
  });

  it("audits villa.create with the full new snapshot and request metadata", async () => {
    repo.create.mockResolvedValue(
      listRow({
        id: "new-villa",
        ownerName: "Hala Samir",
        contractor: { id: CON_B, name: "B" },
        electricalEngineer: { id: ELEC_B, name: "Karim" },
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        budgetMinor: 100n,
        currency: "EGP",
      }),
    );

    await service.create(actor, input({ contractorId: CON_B }), ctx);

    expect(auditEntry()).toMatchObject({
      action: "villa.create",
      entity: "Villa",
      actorId: "admin-1",
      entityId: "new-villa",
      after: {
        villaNumber: "P-001",
        ownerName: "Hala Samir",
        areaId: AREA,
        block: "B1",
        plot: "12",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_B,
        contractorId: CON_B,
        startDate: "2026-01-05",
        targetDate: null,
        budgetMinor: 100,
        currency: "EGP",
      },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
    expect(auditEntry()).not.toHaveProperty("before", expect.anything());
  });

  it.each([
    ["Villa_villaNumber_key", "VILLA_NUMBER_TAKEN", "رقم الفيلا مستخدم بالفعل"],
    ["Villa_areaId_block_plot_key", "VILLA_PLOT_TAKEN", "توجد فيلا بالفعل لهذه المنطقة والقطاع والقطعة"],
  ])("maps a unique violation on %s to 409 %s, including the race", async (constraint, code, message) => {
    repo.create.mockRejectedValue(dbError("P2002", constraint));

    expect(await failure(service.create(actor, input(), ctxAr))).toMatchObject({
      statusCode: 409,
      code,
      message,
    });
  });

  it("also reads the constraint from meta.target, as other Prisma setups report it", async () => {
    repo.create.mockRejectedValue(
      Object.assign(new Error("x"), { code: "P2002", meta: { target: ["areaId", "block", "plot"] } }),
    );

    expect(await failure(service.create(actor, input(), ctx))).toMatchObject({ code: "VILLA_PLOT_TAKEN" });
  });

  it("does not guess when a unique violation names a constraint it does not know", async () => {
    repo.create.mockRejectedValue(dbError("P2002", "Something_else_key"));

    await expect(service.create(actor, input(), ctx)).rejects.toMatchObject({ code: "P2002" });
  });

  it("maps a foreign key lost in a race: area, both engineers and contractor all to 404", async () => {
    repo.create.mockRejectedValueOnce(dbError("P2003", "Villa_areaId_fkey"));
    repo.create.mockRejectedValueOnce(dbError("P2003", "Villa_civilEngineerId_fkey"));
    repo.create.mockRejectedValueOnce(dbError("P2003", "Villa_electricalEngineerId_fkey"));
    repo.create.mockRejectedValueOnce(dbError("P2003", "Villa_contractorId_fkey"));

    expect(await failure(service.create(actor, input(), ctx))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
    });
    expect(await failure(service.create(actor, input(), ctx))).toMatchObject({
      statusCode: 404,
      code: "CIVIL_ENGINEER_NOT_FOUND",
    });
    expect(await failure(service.create(actor, input(), ctx))).toMatchObject({
      statusCode: 404,
      code: "ELECTRICAL_ENGINEER_NOT_FOUND",
    });
    expect(await failure(service.create(actor, input(), ctx))).toMatchObject({
      statusCode: 404,
      code: "CONTRACTOR_NOT_FOUND",
    });
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.create(actor, input(), ctx)).rejects.toThrow("audit down");
  });
});

describe("update", () => {
  const update = (input: UpdateVillaInput, id = "villa-1") => service.update(actor, id, input, ctx);

  beforeEach(() => {
    repo.findSnapshot.mockResolvedValue(snapshotRow());
    repo.areaExists.mockResolvedValue(true);
    repo.civilEngineerStatus.mockResolvedValue("ACTIVE");
    repo.electricalEngineerStatus.mockResolvedValue("ACTIVE");
    repo.contractorStatus.mockResolvedValue("ACTIVE");
    repo.findListRow.mockResolvedValue(listRow());
  });

  it("answers 404 for an unknown villa and does nothing else", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.update(actor, "x", { block: "B2" }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
      message: "الفيلا غير موجودة",
    });
    expect(repo.updateScalars).not.toHaveBeenCalled();
  });

  it("sends only the fields that were given, and returns the refreshed villa", async () => {
    repo.findListRow.mockResolvedValue(listRow({ block: "B2" }));

    const dto = await update({ block: "B2", plot: "13" });

    expect(repo.updateScalars).toHaveBeenCalledWith("villa-1", 1, { block: "B2", plot: "13" }, tx);
    expect(dto.block).toBe("B2");
    expect(repo.transaction).toHaveBeenCalledTimes(1);
  });

  it("only looks the area up when it actually changes", async () => {
    await update({ areaId: AREA });
    expect(repo.areaExists).not.toHaveBeenCalled();

    await update({ areaId: AREA2 });
    expect(repo.areaExists).toHaveBeenCalledWith(AREA2);
    expect(repo.updateScalars.mock.calls[1]?.[2]).toEqual({ areaId: AREA2 });
  });

  it("answers 404 AREA_NOT_FOUND for a new area that does not exist, and writes nothing", async () => {
    repo.areaExists.mockResolvedValue(false);

    expect(await failure(service.update(actor, "villa-1", { areaId: AREA2 }, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "AREA_NOT_FOUND",
      message: "المنطقة غير موجودة",
    });
    expect(repo.updateScalars).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("audits a moved villa with the old and new area id", async () => {
    await update({ areaId: AREA2 });

    expect(auditEntry()).toMatchObject({
      action: "villa.update",
      before: { areaId: AREA },
      after: { areaId: AREA2 },
    });
  });

  it("only looks the engineer up when it actually changes", async () => {
    await update({ civilEngineerId: ENG });
    expect(repo.civilEngineerStatus).not.toHaveBeenCalled();

    await update({ civilEngineerId: ENG2 });
    expect(repo.civilEngineerStatus).toHaveBeenCalledWith(ENG2);
  });

  it("answers 404 CIVIL_ENGINEER_NOT_FOUND for a new engineer that does not exist", async () => {
    repo.civilEngineerStatus.mockResolvedValue(null);

    expect(await failure(update({ civilEngineerId: ENG2 }))).toMatchObject({
      code: "CIVIL_ENGINEER_NOT_FOUND",
    });
    expect(repo.updateScalars).not.toHaveBeenCalled();
  });

  describe("contractor", () => {
    it("only looks the contractor up when a different one is set", async () => {
      await update({ contractorId: CON_A });
      expect(repo.contractorStatus).not.toHaveBeenCalled();

      await update({ contractorId: CON_B });
      expect(repo.contractorStatus).toHaveBeenCalledWith(CON_B);
      expect(repo.updateScalars.mock.calls[1]?.[2]).toEqual({ contractorId: CON_B });
    });

    it("clears the contractor with null, without looking anything up", async () => {
      await update({ contractorId: null });

      expect(repo.contractorStatus).not.toHaveBeenCalled();
      expect(repo.updateScalars).toHaveBeenCalledWith("villa-1", 1, { contractorId: null }, tx);
    });

    describe("the hooks that follow the contractor", () => {
      const hook = vi.fn<ContractorChangeHook>();
      const hooked = () => new VillasService(repo as unknown as VillasRepository, [hook]);

      beforeEach(() => {
        hook.mockReset();
        hook.mockResolvedValue(undefined);
      });

      it("runs in the update's transaction, after the write and before the audit entry, with the old and the new contractor", async () => {
        const order: string[] = [];
        repo.updateScalars.mockImplementation(async () => (order.push("write"), true));
        hook.mockImplementation(async () => void order.push("hook"));
        vi.mocked(audit.record).mockImplementation(async () => void order.push("audit"));

        await hooked().update(actor, "villa-1", { contractorId: CON_B }, ctx);

        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith(tx, {
          villaId: "villa-1",
          before: CON_A,
          after: CON_B,
          actor,
          ctx,
        });
        expect(order).toEqual(["write", "hook", "audit"]);
      });

      it("is told when the contractor is cleared, and when a villa without one gets one", async () => {
        await hooked().update(actor, "villa-1", { contractorId: null }, ctx);
        repo.findSnapshot.mockResolvedValue(snapshotRow({ contractorId: null }));
        await hooked().update(actor, "villa-1", { contractorId: CON_B }, ctx);

        expect(hook.mock.calls.map(([, change]) => [change.before, change.after])).toEqual([
          [CON_A, null],
          [null, CON_B],
        ]);
      });

      it("is not told when the contractor is sent unchanged, or not sent", async () => {
        await hooked().update(actor, "villa-1", { contractorId: CON_A }, ctx);
        await hooked().update(actor, "villa-1", { block: "B2" }, ctx);
        repo.findSnapshot.mockResolvedValue(snapshotRow({ contractorId: null }));
        await hooked().update(actor, "villa-1", { contractorId: null }, ctx);

        expect(hook).not.toHaveBeenCalled();
      });

      it("is not told when the update is refused", async () => {
        repo.contractorStatus.mockResolvedValue("INACTIVE");
        await failure(hooked().update(actor, "villa-1", { contractorId: CON_B }, ctx));
        repo.updateScalars.mockResolvedValue(false);
        repo.contractorStatus.mockResolvedValue("ACTIVE");
        await failure(hooked().update(actor, "villa-1", { contractorId: CON_B }, ctx));

        expect(hook).not.toHaveBeenCalled();
      });

      it("undoes the whole update when a hook throws: no audit entry, and the error goes out as it is", async () => {
        hook.mockRejectedValue(new Error("hook down"));

        await expect(hooked().update(actor, "villa-1", { contractorId: CON_B }, ctx)).rejects.toThrow(
          "hook down",
        );

        expect(audit.record).not.toHaveBeenCalled();
      });

      it("runs every hook, in the order they were registered", async () => {
        const order: string[] = [];
        const first = vi.fn<ContractorChangeHook>(async () => void order.push("first"));
        const second = vi.fn<ContractorChangeHook>(async () => void order.push("second"));

        await new VillasService(repo as unknown as VillasRepository, [first, second]).update(
          actor,
          "villa-1",
          { contractorId: CON_B },
          ctx,
        );

        expect(order).toEqual(["first", "second"]);
      });
    });

    it("does not touch the contractor when contractorId is not sent", async () => {
      await update({ block: "B2" });

      expect(repo.updateScalars.mock.calls[0]?.[2]).not.toHaveProperty("contractorId");
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for a contractor that does not exist, and writes nothing", async () => {
      repo.contractorStatus.mockResolvedValue(null);

      expect(await failure(service.update(actor, "villa-1", { contractorId: CON_B }, ctxAr))).toMatchObject({
        statusCode: 404,
        code: "CONTRACTOR_NOT_FOUND",
        message: "المقاول غير موجود",
      });
      expect(repo.updateScalars).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe("electrical engineer", () => {
    it("sets one, looking it up only when it differs from the stored one", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ electricalEngineerId: ELEC_A }));

      await update({ electricalEngineerId: ELEC_A });
      expect(repo.electricalEngineerStatus).not.toHaveBeenCalled();

      await update({ electricalEngineerId: ELEC_B });
      expect(repo.electricalEngineerStatus).toHaveBeenCalledWith(ELEC_B);
      expect(repo.updateScalars.mock.calls[1]?.[2]).toEqual({ electricalEngineerId: ELEC_B });
    });

    it("clears it with null, without looking anything up", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ electricalEngineerId: ELEC_A }));

      await update({ electricalEngineerId: null });

      expect(repo.electricalEngineerStatus).not.toHaveBeenCalled();
      expect(repo.updateScalars).toHaveBeenCalledWith("villa-1", 1, { electricalEngineerId: null }, tx);
    });

    it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND for one that does not exist, and writes nothing", async () => {
      repo.electricalEngineerStatus.mockResolvedValue(null);

      expect(
        await failure(service.update(actor, "villa-1", { electricalEngineerId: ELEC_B }, ctxAr)),
      ).toMatchObject({
        statusCode: 404,
        code: "ELECTRICAL_ENGINEER_NOT_FOUND",
        message: "مهندس الكهرباء غير موجود",
      });
      expect(repo.updateScalars).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("records the change in the audit entry, null when it was not set", async () => {
      await update({ electricalEngineerId: ELEC_B });

      expect(auditEntry()).toMatchObject({
        before: { electricalEngineerId: null },
        after: { electricalEngineerId: ELEC_B },
      });
    });
  });

  describe("an inactive party is refused only when this request sets or changes it", () => {
    it("refuses a new inactive civil engineer, electrical engineer or contractor with 400 and writes nothing", async () => {
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");
      expect(await failure(service.update(actor, "villa-1", { civilEngineerId: ENG2 }, ctxAr))).toMatchObject(
        {
          statusCode: 400,
          code: "CIVIL_ENGINEER_INACTIVE",
          message: "هذا المهندس المدني غير نشط ولا يمكن تعيينه على فيلا",
        },
      );

      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");
      expect(
        await failure(service.update(actor, "villa-1", { electricalEngineerId: ELEC_A }, ctxAr)),
      ).toMatchObject({
        statusCode: 400,
        code: "ELECTRICAL_ENGINEER_INACTIVE",
      });

      repo.contractorStatus.mockResolvedValue("INACTIVE");
      expect(await failure(service.update(actor, "villa-1", { contractorId: CON_B }, ctxAr))).toMatchObject({
        statusCode: 400,
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على فيلا",
      });

      expect(repo.updateScalars).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("saves other fields of a villa whose parties have since been switched off", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ electricalEngineerId: ELEC_A }));
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");
      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");
      repo.contractorStatus.mockResolvedValue("INACTIVE");

      await update({ block: "B2", ownerName: "New Owner" });

      expect(repo.updateScalars).toHaveBeenCalledWith(
        "villa-1",
        1,
        { block: "B2", ownerName: "New Owner" },
        tx,
      );
      expect(repo.civilEngineerStatus).not.toHaveBeenCalled();
      expect(repo.electricalEngineerStatus).not.toHaveBeenCalled();
      expect(repo.contractorStatus).not.toHaveBeenCalled();
    });

    it("accepts the unchanged inactive parties sent back as they are (a full form save)", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ electricalEngineerId: ELEC_A }));
      repo.civilEngineerStatus.mockResolvedValue("INACTIVE");
      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");
      repo.contractorStatus.mockResolvedValue("INACTIVE");

      await update({ civilEngineerId: ENG, electricalEngineerId: ELEC_A, contractorId: CON_A, block: "B2" });

      expect(repo.updateScalars).toHaveBeenCalledTimes(1);
      expect(repo.civilEngineerStatus).not.toHaveBeenCalled();
    });

    it("always lets the party be removed (null), whatever its status", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ electricalEngineerId: ELEC_A }));
      repo.electricalEngineerStatus.mockResolvedValue("INACTIVE");
      repo.contractorStatus.mockResolvedValue("INACTIVE");

      await update({ electricalEngineerId: null, contractorId: null });

      expect(repo.updateScalars).toHaveBeenCalledTimes(1);
    });

    it("accepts a new party that is active", async () => {
      await update({ civilEngineerId: ENG2, electricalEngineerId: ELEC_B, contractorId: CON_B });

      expect(repo.updateScalars).toHaveBeenCalledTimes(1);
    });
  });

  describe("owner name", () => {
    it("is set and cleared with null, and audited", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ ownerName: "Old Owner" }));

      await update({ ownerName: "New Owner" });
      await update({ ownerName: null });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ ownerName: "New Owner" });
      expect(repo.updateScalars.mock.calls[1]?.[2]).toEqual({ ownerName: null });
      expect(auditEntry(0)).toMatchObject({
        before: { ownerName: "Old Owner" },
        after: { ownerName: "New Owner" },
      });
      expect(auditEntry(1)).toMatchObject({ before: { ownerName: "Old Owner" }, after: { ownerName: null } });
    });
  });

  describe("budget", () => {
    it("sets a budget on a villa without one, with the default KWD", async () => {
      await update({ budgetMinor: 5000 });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 5000, currency: "KWD" });
      expect(auditEntry()).toMatchObject({
        before: { budgetMinor: null, currency: null },
        after: { budgetMinor: 5000, currency: "KWD" },
      });
    });

    it("sets a budget with EGP when EGP is sent", async () => {
      await update({ budgetMinor: 5000, currency: "EGP" });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 5000, currency: "EGP" });
    });

    it("sets a budget with its currency in one go", async () => {
      await update({ budgetMinor: 5000, currency: "USD" });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 5000, currency: "USD" });
    });

    it("changes the amount and keeps the stored currency", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ budgetMinor: 100n, currency: "USD" }));

      await update({ budgetMinor: 250 });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 250, currency: "USD" });
      expect(auditEntry()?.before).toEqual({ budgetMinor: 100 });
      expect(auditEntry()?.after).toEqual({ budgetMinor: 250 });
    });

    it("changes the currency alone while the villa has a budget", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ budgetMinor: 100n, currency: "USD" }));

      await update({ currency: "EUR" });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 100, currency: "EUR" });
      expect(auditEntry()?.before).toEqual({ currency: "USD" });
      expect(auditEntry()?.after).toEqual({ currency: "EUR" });
    });

    it("refuses a currency alone on a villa without a budget (400, on the currency field)", async () => {
      const err = await failure(service.update(actor, "villa-1", { currency: "USD" }, ctxAr));

      expect(err).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
      expect(err.details).toEqual([{ path: "currency", message: "لا يمكن تحديد العملة إلا مع الميزانية" }]);
      expect(repo.updateScalars).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("removes the budget and its currency together with null", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ budgetMinor: 100n, currency: "USD" }));

      await update({ budgetMinor: null });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: null, currency: null });
      expect(auditEntry()).toMatchObject({
        before: { budgetMinor: 100, currency: "USD" },
        after: { budgetMinor: null, currency: null },
      });
    });

    it("leaves a villa that never had a budget at null/null when null is sent again, recording nothing", async () => {
      await update({ budgetMinor: null });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: null, currency: null });
      expect(auditEntry()?.before).toEqual({});
      expect(auditEntry()?.after).toEqual({});
    });

    it("does not touch the budget when neither field is sent", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ budgetMinor: 100n, currency: "USD" }));

      await update({ block: "B2" });

      const patch = repo.updateScalars.mock.calls[0]?.[2];
      expect(patch).not.toHaveProperty("budgetMinor");
      expect(patch).not.toHaveProperty("currency");
    });

    it("gives a villa that somehow has a budget but no stored currency the default", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ budgetMinor: 100n, currency: null }));

      await update({ budgetMinor: 200 });

      expect(repo.updateScalars.mock.calls[0]?.[2]).toEqual({ budgetMinor: 200, currency: "KWD" });
    });
  });

  describe("the date rule is checked against the values the villa will have", () => {
    it("rejects a target date before the stored start date", async () => {
      const err = await failure(
        service.update(actor, "villa-1", { targetDate: new Date("2026-01-04T00:00:00.000Z") }, ctxAr),
      );

      expect(err).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR", message: "فشل التحقق" });
      expect(err.details).toEqual([
        { path: "targetDate", message: "يجب ألا يكون التاريخ المستهدف قبل تاريخ البدء" },
      ]);
    });

    it("rejects a start date after the stored target date", async () => {
      expect(await failure(update({ startDate: new Date("2026-03-02T00:00:00.000Z") }))).toMatchObject({
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    });

    it("accepts equal dates, a valid new date, and clearing a date", async () => {
      await update({ targetDate: new Date("2026-01-05T00:00:00.000Z") });
      await update({ startDate: new Date("2026-02-01T00:00:00.000Z") });
      await update({ startDate: null });
      await update({ targetDate: null, startDate: new Date("2030-01-01T00:00:00.000Z") });

      expect(repo.updateScalars).toHaveBeenCalledTimes(4);
    });

    it("accepts any dates when the stored one is not set", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow({ startDate: null }));

      await update({ targetDate: new Date("2000-01-01T00:00:00.000Z") });

      expect(repo.updateScalars).toHaveBeenCalled();
    });
  });

  describe("audit", () => {
    it("records only the fields that really change, with their old and new values", async () => {
      await update({ block: "B2", areaId: AREA, startDate: new Date("2026-02-01T00:00:00.000Z") });

      expect(auditEntry()).toMatchObject({
        action: "villa.update",
        entity: "Villa",
        actorId: "admin-1",
        entityId: "villa-1",
        before: { block: "B1", startDate: "2026-01-05" },
        after: { block: "B2", startDate: "2026-02-01" },
      });
      expect(auditEntry()?.before).not.toHaveProperty("areaId");
      expect(auditEntry()?.after).not.toHaveProperty("areaId");
    });

    it("records a changed contractor, and a cleared one as null", async () => {
      await update({ contractorId: CON_B });
      await update({ contractorId: null });

      expect(auditEntry(0)).toMatchObject({
        before: { contractorId: CON_A },
        after: { contractorId: CON_B },
      });
      expect(auditEntry(1)).toMatchObject({
        before: { contractorId: CON_A },
        after: { contractorId: null },
      });
    });

    it("records a cleared date as null", async () => {
      await update({ targetDate: null });

      expect(auditEntry()).toMatchObject({
        before: { targetDate: "2026-03-01" },
        after: { targetDate: null },
      });
    });

    it("writes the audit row in the same transaction", async () => {
      await update({ block: "B2" });

      expect(auditCalls()[0]?.[0]).toBe(tx);
    });

    it("fails as a whole when the audit write fails", async () => {
      vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

      await expect(update({ block: "B2" })).rejects.toThrow("audit down");
    });
  });

  describe("write errors", () => {
    it.each([
      ["Villa_villaNumber_key", "VILLA_NUMBER_TAKEN"],
      ["Villa_areaId_block_plot_key", "VILLA_PLOT_TAKEN"],
    ])("maps a unique violation on %s to 409 %s", async (constraint, code) => {
      repo.updateScalars.mockRejectedValue(dbError("P2002", constraint));

      expect(await failure(update({ villaNumber: "P-2" }))).toMatchObject({ statusCode: 409, code });
    });

    it("maps P2025 (deleted mid-request) to 404", async () => {
      repo.updateScalars.mockRejectedValue(dbError("P2025"));

      expect(await failure(update({ block: "B2" }))).toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("maps a lost area foreign key to 404 AREA_NOT_FOUND", async () => {
      repo.updateScalars.mockRejectedValueOnce(dbError("P2003", "Villa_areaId_fkey"));

      expect(await failure(update({ areaId: AREA2 }))).toMatchObject({
        statusCode: 404,
        code: "AREA_NOT_FOUND",
      });
    });

    it("maps a lost engineer or contractor foreign key", async () => {
      repo.updateScalars.mockRejectedValueOnce(dbError("P2003", "Villa_civilEngineerId_fkey"));
      repo.updateScalars.mockRejectedValueOnce(dbError("P2003", "Villa_electricalEngineerId_fkey"));
      repo.updateScalars.mockRejectedValueOnce(dbError("P2003", "Villa_contractorId_fkey"));

      expect(await failure(update({ civilEngineerId: ENG2 }))).toMatchObject({
        code: "CIVIL_ENGINEER_NOT_FOUND",
      });
      expect(await failure(update({ electricalEngineerId: ELEC_B }))).toMatchObject({
        statusCode: 404,
        code: "ELECTRICAL_ENGINEER_NOT_FOUND",
      });
      expect(await failure(update({ contractorId: CON_B }))).toMatchObject({
        statusCode: 404,
        code: "CONTRACTOR_NOT_FOUND",
      });
    });

    it("answers 404 if the villa vanishes before it can be re-read", async () => {
      repo.findListRow.mockResolvedValue(null);

      expect(await failure(update({ block: "B2" }))).toMatchObject({ code: "VILLA_NOT_FOUND" });
    });

    it("lets other errors through unchanged", async () => {
      repo.updateScalars.mockRejectedValue(new Error("connection lost"));

      await expect(update({ block: "B2" })).rejects.toThrow("connection lost");
    });
  });
});

describe("remove", () => {
  it("answers 404 for an unknown villa and deletes nothing", async () => {
    repo.lockVersion.mockResolvedValue(null);

    expect(await failure(service.remove(actor, "x", ctx))).toMatchObject({ code: "VILLA_NOT_FOUND" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes inside a transaction and audits the full snapshot, including the contractor and the budget", async () => {
    repo.findSnapshot.mockResolvedValue(
      snapshotRow({
        ownerName: "Hala Samir",
        electricalEngineerId: ELEC_A,
        budgetMinor: 900n,
        currency: "EGP",
      }),
    );

    await expect(service.remove(actor, "villa-1", ctx)).resolves.toBeUndefined();

    expect(repo.delete).toHaveBeenCalledWith("villa-1", 1, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "villa.delete",
      entity: "Villa",
      actorId: "admin-1",
      entityId: "villa-1",
      before: {
        villaNumber: "P-001",
        ownerName: "Hala Samir",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
        startDate: "2026-01-05",
        budgetMinor: 900,
        currency: "EGP",
      },
    });
    expect(auditEntry()?.after).toBeUndefined();
  });

  describe("a villa with open works", () => {
    it("is refused with 409 VILLA_HAS_RECORDS, translated, when any were typed in by hand: nothing is deleted or audited", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      manualItems.mockResolvedValue(2);

      expect(await failure(service.remove(actor, "villa-1", ctxAr))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
        message:
          "هذه الفيلا بها أعمال مفتوحة أُضيفت يدويًا أو أعمال صغيرة يومية أو تقارير موقع أو عمالة يومية أو توريدات مواد. احذفها أولاً",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(removeVillaDocuments).not.toHaveBeenCalled();
    });

    it("counts only the MANUAL works of this villa, after the villa is locked", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      const order: string[] = [];
      repo.lockVersion.mockImplementation(async () => (order.push("lock"), 1));
      manualItems.mockImplementation(async () => (order.push("count"), 0));
      smallWorks.mockImplementation(async () => (order.push("small works"), 0));
      siteReports.mockImplementation(async () => (order.push("site reports"), 0));
      labour.mockImplementation(async () => (order.push("daily labour"), 0));
      deliveries.mockImplementation(async () => (order.push("deliveries"), 0));
      repo.delete.mockImplementation(async () => (order.push("delete"), true));

      await service.remove(actor, "villa-1", ctx);

      expect(manualItems).toHaveBeenCalledWith({ where: { villaId: "villa-1", source: "MANUAL" } });
      expect(smallWorks).toHaveBeenCalledWith({ where: { villaId: "villa-1" } });
      expect(siteReports).toHaveBeenCalledWith({ where: { villaId: "villa-1" } });
      expect(labour).toHaveBeenCalledWith({ where: { villaId: "villa-1" } });
      expect(deliveries).toHaveBeenCalledWith({ where: { villaId: "villa-1" } });
      expect(order).toEqual([
        "lock",
        "count",
        "small works",
        "site reports",
        "daily labour",
        "deliveries",
        "delete",
      ]);
    });

    it("is refused with 409 VILLA_HAS_RECORDS when it has a material delivery: nothing is deleted", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      deliveries.mockResolvedValue(1);

      expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
      });
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("is refused with 409 VILLA_HAS_RECORDS when it has a daily labour row, whatever else it has: nothing is deleted or audited", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      labour.mockResolvedValue(1);

      expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
        message:
          "This villa has open works that were added by hand, daily small works, site reports, daily labour or material deliveries. Delete them first",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(removeVillaDocuments).not.toHaveBeenCalled();
    });

    it("is refused with 409 VILLA_HAS_RECORDS when it has a site report, whatever else it has: nothing is deleted or audited", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      siteReports.mockResolvedValue(1);

      expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
        message:
          "This villa has open works that were added by hand, daily small works, site reports, daily labour or material deliveries. Delete them first",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(removeVillaDocuments).not.toHaveBeenCalled();
    });

    it("is refused with 409 VILLA_HAS_RECORDS when it has a daily small work, whatever its open works: nothing is deleted or audited", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      smallWorks.mockResolvedValue(1);

      expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
        message:
          "This villa has open works that were added by hand, daily small works, site reports, daily labour or material deliveries. Delete them first",
      });
      expect(repo.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(removeVillaDocuments).not.toHaveBeenCalled();
    });

    it("does not look at the daily reports at all: they belong to a contractor, not to a villa", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());

      await service.remove(actor, "villa-1", ctx);

      expect(reports).not.toHaveBeenCalled();
    });

    it("answers the same 409 when a report slipped in after the counts and the foreign key stops the delete", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      repo.delete.mockRejectedValueOnce(Object.assign(new Error("Prisma P2003"), { code: "P2003" }));

      expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(removeVillaDocuments).not.toHaveBeenCalled();
    });

    it("is deleted when it has none: the automatic ones go with it", async () => {
      repo.findSnapshot.mockResolvedValue(snapshotRow());
      manualItems.mockResolvedValue(0);

      await expect(service.remove(actor, "villa-1", ctx)).resolves.toBeUndefined();

      expect(repo.delete).toHaveBeenCalledTimes(1);
    });
  });

  it("removes the villa's folder from disk only after the transaction has committed", async () => {
    repo.findSnapshot.mockResolvedValue(snapshotRow());
    const order: string[] = [];
    repo.transaction.mockImplementation(async (work: (client: Db) => Promise<unknown>) => {
      const result = await work(tx);
      order.push("committed");
      return result;
    });
    vi.mocked(removeVillaDocuments).mockImplementation(async () => void order.push("disk"));

    await service.remove(actor, "villa-1", ctx);

    expect(removeVillaDocuments).toHaveBeenCalledTimes(1);
    expect(removeVillaDocuments).toHaveBeenCalledWith("villa-1");
    expect(order).toEqual(["committed", "disk"]);
  });

  it("leaves the disk alone when the villa is unknown or the delete fails", async () => {
    repo.lockVersion.mockResolvedValue(null);
    await failure(service.remove(actor, "x", ctx));

    repo.lockVersion.mockResolvedValue(1);
    repo.findSnapshot.mockResolvedValue(snapshotRow());
    repo.delete.mockRejectedValue(dbError("P2025"));
    await failure(service.remove(actor, "villa-1", ctx));

    repo.delete.mockReset();
    repo.delete.mockResolvedValue(true);
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));
    await expect(service.remove(actor, "villa-1", ctx)).rejects.toThrow("audit down");

    expect(removeVillaDocuments).not.toHaveBeenCalled();
  });

  it("maps P2025 (already deleted) to 404", async () => {
    repo.findSnapshot.mockResolvedValue(snapshotRow());
    repo.delete.mockRejectedValue(dbError("P2025"));

    expect(await failure(service.remove(actor, "villa-1", ctx))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
    });
  });

  it("lets other errors through, and fails as a whole when the audit write fails", async () => {
    repo.findSnapshot.mockResolvedValue(snapshotRow());
    repo.delete.mockRejectedValueOnce(new Error("connection lost"));
    await expect(service.remove(actor, "villa-1", ctx)).rejects.toThrow("connection lost");

    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));
    await expect(service.remove(actor, "villa-1", ctx)).rejects.toThrow("audit down");
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
  const base = { villaNumber: "P-1", areaId: AREA, block: "B", plot: "1", civilEngineerId: ENG };
  const create = (extra: Record<string, unknown> = {}) => createVillaSchema.safeParse({ ...base, ...extra });

  describe("create", () => {
    it("adds no defaults: no contractor and no dates unless they are sent", () => {
      const result = create();

      expect(result.success && result.data).toEqual(base);
    });

    it.each(["villaNumber", "block", "plot"])("trims %s and accepts 1 to 50 characters", (field) => {
      expect(create({ [field]: "  x  " }).data?.[field as "block"]).toBe("x");
      expect(create({ [field]: "x".repeat(50) }).success).toBe(true);
      for (const bad of ["", "   ", "x".repeat(51)]) {
        expect(issues(create({ [field]: bad }))).toEqual([{ path: field, message: "validation.textLength" }]);
      }
    });

    it("takes the area as a UUID in areaId, and no longer as text", () => {
      expect(issues(create({ areaId: "New Cairo" }))).toEqual([
        { path: "areaId", message: "validation.idInvalid" },
      ]);
      expect(issues(create({ areaId: "" }))).toEqual([{ path: "areaId", message: "validation.idInvalid" }]);
      expect(create({ areaId: AREA2 }).success).toBe(true);
      expect(create({ area: "New Cairo" }).success).toBe(false);
    });

    it("requires the identifying fields and the engineer", () => {
      expect(issues(createVillaSchema.safeParse({}))).toEqual([
        { path: "villaNumber", message: "validation.required" },
        { path: "areaId", message: "validation.required" },
        { path: "block", message: "validation.required" },
        { path: "plot", message: "validation.required" },
        { path: "civilEngineerId", message: "validation.required" },
      ]);
      expect(issues(create({ civilEngineerId: "nope" }))).toEqual([
        { path: "civilEngineerId", message: "validation.idInvalid" },
      ]);
    });

    it("rejects unknown keys, including the ones a client must not set or that no longer exist", () => {
      for (const extra of [
        { createdById: ENG },
        { id: ENG },
        { progress: 1 },
        { activities: [] },
        { status: "OPEN" },
        { checklistCompleted: true },
        { materialRequested: true },
        { contractorIds: [CON_A] },
        { plotNumber: "1" },
        { projectNumber: "P-1" },
      ]) {
        expect(create(extra).success).toBe(false);
      }
    });

    it("takes one contractor id, or null for none, and rejects anything else", () => {
      expect(create({ contractorId: CON_A }).data?.contractorId).toBe(CON_A);
      expect(create({ contractorId: null }).data?.contractorId).toBeNull();
      expect(issues(create({ contractorId: "nope" }))).toEqual([
        { path: "contractorId", message: "validation.idInvalid" },
      ]);
      expect(issues(create({ contractorId: 5 }))).toEqual([
        { path: "contractorId", message: "validation.required" },
      ]);
    });

    it("takes calendar days (YYYY-MM-DD) as UTC midnight, and allows null", () => {
      const result = create({ startDate: "2026-01-05", targetDate: "2026-03-01" });

      expect(result.success && result.data.startDate?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
      expect(result.success && result.data.targetDate?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
      expect(create({ startDate: null, targetDate: null }).success).toBe(true);
    });

    it("refuses anything but a calendar day: a time, an offset, impossible or oddly written dates", () => {
      for (const bad of [
        "2026-02-30",
        "05/01/2026",
        "2026-01-05T10:00:00",
        "2026-01-05T00:00:00Z",
        "2026-01-05T12:00:00+02:00",
        "2026-1-5",
        " 2026-01-05",
        "",
        20260105,
      ]) {
        expect(issues(create({ startDate: bad }))).toEqual([
          { path: "startDate", message: "validation.calendarDateInvalid" },
        ]);
        expect(issues(create({ targetDate: bad }))).toEqual([
          { path: "targetDate", message: "validation.calendarDateInvalid" },
        ]);
      }
    });

    it("takes an owner name, trimmed, 1 to 120 characters, or null for none", () => {
      expect(create({ ownerName: "  Hala Samir  " }).data?.ownerName).toBe("Hala Samir");
      expect(create({ ownerName: null }).data?.ownerName).toBeNull();
      expect(create({ ownerName: "x".repeat(120) }).success).toBe(true);
      for (const bad of ["", "   ", "x".repeat(121)]) {
        expect(issues(create({ ownerName: bad }))).toEqual([
          { path: "ownerName", message: "validation.ownerNameLength" },
        ]);
      }
      expect(create().data).not.toHaveProperty("ownerName");
    });

    it("takes one electrical engineer id, or null for none, and rejects anything else", () => {
      expect(create({ electricalEngineerId: ELEC_A }).data?.electricalEngineerId).toBe(ELEC_A);
      expect(create({ electricalEngineerId: null }).data?.electricalEngineerId).toBeNull();
      expect(issues(create({ electricalEngineerId: "nope" }))).toEqual([
        { path: "electricalEngineerId", message: "validation.idInvalid" },
      ]);
    });

    describe("budget and currency", () => {
      it("takes a whole number of minor units from 0 up to 2^53 - 1", () => {
        for (const ok of [0, 1, 125050, Number.MAX_SAFE_INTEGER]) {
          expect(create({ budgetMinor: ok }).data?.budgetMinor).toBe(ok);
        }
        expect(create({ budgetMinor: null }).data?.budgetMinor).toBeNull();
      });

      it.each([-1, 1.5, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "100", "", true, [], {}])(
        "refuses %j as a budget",
        (bad) => {
          expect(issues(create({ budgetMinor: bad }))).toEqual([
            { path: "budgetMinor", message: "validation.budgetInvalid" },
          ]);
        },
      );

      it("keeps the currency in capitals, whatever case it is sent in", () => {
        expect(create({ budgetMinor: 5, currency: "usd" }).data?.currency).toBe("USD");
        expect(create({ budgetMinor: 5, currency: " Egp " }).data?.currency).toBe("EGP");
      });

      it("accepts real ISO 4217 codes and refuses anything else", () => {
        for (const code of ["EGP", "USD", "EUR", "SAR", "AED", "JPY", "KWD"]) {
          expect(create({ budgetMinor: 1, currency: code }).success).toBe(true);
        }
        for (const bad of ["EG", "EGPP", "XYZ", "E1P", "", "   ", "جنيه"]) {
          expect(issues(create({ budgetMinor: 1, currency: bad }))).toEqual([
            { path: "currency", message: "validation.currencyInvalid" },
          ]);
        }
      });

      it("refuses a currency without a budget, null or missing", () => {
        const expected = [{ path: "currency", message: "validation.currencyWithoutBudget" }];

        expect(issues(create({ currency: "USD" }))).toEqual(expected);
        expect(issues(create({ currency: "USD", budgetMinor: null }))).toEqual(expected);
        expect(create({ currency: "USD", budgetMinor: 0 }).success).toBe(true);
      });

      it("leaves the currency out when it is not sent (the service gives it the default)", () => {
        expect(create({ budgetMinor: 5 }).data).not.toHaveProperty("currency");
      });
    });

    it("rejects a target date before the start date, and accepts equal or one-sided dates", () => {
      expect(issues(create({ startDate: "2026-02-01", targetDate: "2026-01-31" }))).toEqual([
        { path: "targetDate", message: "validation.targetBeforeStart" },
      ]);
      expect(create({ startDate: "2026-02-01", targetDate: "2026-02-01" }).success).toBe(true);
      expect(create({ targetDate: "2000-01-01" }).success).toBe(true);
      expect(create({ startDate: "2099-01-01", targetDate: null }).success).toBe(true);
    });
  });

  describe("update", () => {
    const parse = (input: Record<string, unknown>) => updateVillaSchema.safeParse(input);

    it("needs at least one field, and never adds defaults for the ones not sent", () => {
      expect(issues(parse({}))).toEqual([{ path: "", message: "validation.atLeastOneField" }]);
      const result = parse({ block: "B2" });
      expect(result.success && Object.keys(result.data)).toEqual(["block"]);
    });

    it("checks areaId as a UUID, and refuses the old text field", () => {
      expect(issues(parse({ areaId: "x" }))).toEqual([{ path: "areaId", message: "validation.idInvalid" }]);
      expect(parse({ areaId: AREA }).success).toBe(true);
      expect(parse({ area: "New Cairo" }).success).toBe(false);
    });

    it("accepts every editable field, and a null contractor, electrical engineer, owner, budget or date to clear it", () => {
      expect(parse({ startDate: null }).success).toBe(true);
      expect(parse({ contractorId: null }).success).toBe(true);
      expect(parse({ electricalEngineerId: null }).success).toBe(true);
      expect(parse({ ownerName: null }).success).toBe(true);
      expect(parse({ budgetMinor: null }).success).toBe(true);
      expect(parse({ contractorId: CON_B }).success).toBe(true);
      expect(
        parse({
          villaNumber: "P-2",
          ownerName: "Hala",
          areaId: AREA2,
          block: "B",
          plot: "9",
          civilEngineerId: ENG2,
          electricalEngineerId: ELEC_B,
          contractorId: CON_A,
          startDate: "2026-01-01",
          targetDate: "2026-06-01",
          budgetMinor: 1000,
          currency: "USD",
        }).success,
      ).toBe(true);
    });

    it("rejects unknown keys and fields that are not editable here", () => {
      for (const extra of [
        { createdById: ENG },
        { activities: [] },
        { progress: 1 },
        { id: ENG },
        { createdAt: "2026-01-01" },
        { status: "OPEN" },
        { contractorIds: [] },
        { location: "x" },
        { budget: 5 },
      ]) {
        expect(parse({ block: "B", ...extra }).success).toBe(false);
      }
    });

    it("checks the date order when both dates are in the request", () => {
      expect(issues(parse({ startDate: "2026-02-01", targetDate: "2026-01-01" }))).toEqual([
        { path: "targetDate", message: "validation.targetBeforeStart" },
      ]);
    });

    it("refuses a datetime for a date, like create", () => {
      expect(issues(parse({ startDate: "2026-01-05T00:00:00Z" }))).toEqual([
        { path: "startDate", message: "validation.calendarDateInvalid" },
      ]);
    });

    it("refuses a currency sent with a null budget, but lets a currency travel alone (the villa may have a budget)", () => {
      expect(issues(parse({ budgetMinor: null, currency: "USD" }))).toEqual([
        { path: "currency", message: "validation.currencyWithoutBudget" },
      ]);
      expect(parse({ currency: "USD" }).success).toBe(true);
      expect(parse({ budgetMinor: 0, currency: "USD" }).success).toBe(true);
    });

    it("applies the same owner and budget rules as create", () => {
      expect(issues(parse({ ownerName: "" }))).toEqual([
        { path: "ownerName", message: "validation.ownerNameLength" },
      ]);
      expect(issues(parse({ budgetMinor: -5 }))).toEqual([
        { path: "budgetMinor", message: "validation.budgetInvalid" },
      ]);
      expect(issues(parse({ currency: "XYZ" }))).toEqual([
        { path: "currency", message: "validation.currencyInvalid" },
      ]);
    });
  });

  describe("list query", () => {
    const parse = (input: Record<string, unknown>) => listVillasQuerySchema.safeParse(input);

    it("applies the shared pagination: limit 1000 ok, 1001 rejected", () => {
      expect(parse({ limit: "1000" }).success).toBe(true);
      expect(parse({ limit: "1001" }).success).toBe(false);
    });

    it("parses the filters, including plot and the electrical engineer", () => {
      const result = parse({
        area: " Area ",
        plot: " 12 ",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
      });

      expect(result.success && result.data).toMatchObject({
        area: "Area",
        plot: "12",
        civilEngineerId: ENG,
        electricalEngineerId: ELEC_A,
        contractorId: CON_A,
      });
    });

    it("parses the area id filter next to the area name filter", () => {
      const result = parse({ area: "New Cairo", areaId: AREA });

      expect(result.success && result.data).toMatchObject({ area: "New Cairo", areaId: AREA });
      expect(issues(parse({ areaId: "x" }))).toEqual([{ path: "areaId", message: "validation.idInvalid" }]);
    });

    it("no longer has the status, checklist or material request filters", () => {
      const result = parse({ status: "CLOSED", checklistCompleted: "true", materialRequested: "false" });

      expect(result.success && result.data).not.toHaveProperty("status");
      expect(result.success && result.data).not.toHaveProperty("checklistCompleted");
      expect(result.success && result.data).not.toHaveProperty("materialRequested");
    });

    it("rejects bad filter values with a specific message", () => {
      expect(issues(parse({ civilEngineerId: "x" }))).toEqual([
        { path: "civilEngineerId", message: "validation.idInvalid" },
      ]);
      expect(issues(parse({ electricalEngineerId: "x" }))).toEqual([
        { path: "electricalEngineerId", message: "validation.idInvalid" },
      ]);
      expect(issues(parse({ contractorId: "x" }))).toEqual([
        { path: "contractorId", message: "validation.idInvalid" },
      ]);
      expect(issues(parse({ area: "x".repeat(51) }))).toEqual([
        { path: "area", message: "validation.textLength" },
      ]);
    });

    it("reads a calendar day as that day at both ends of a range (a DATE column has no time)", () => {
      const result = parse({
        startFrom: "2026-01-31",
        startTo: "2026-01-31",
        targetFrom: "2026-02-01",
        targetTo: "2026-02-01",
      });

      expect(result.success && result.data.startFrom?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
      expect(result.success && result.data.startTo?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
      expect(result.success && result.data.targetTo?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    });

    it("rejects a range that ends before it starts, on the 'to' field, for both date pairs", () => {
      expect(issues(parse({ startFrom: "2026-02-01", startTo: "2026-01-31" }))).toEqual([
        { path: "startTo", message: "validation.dateRangeInvalid" },
      ]);
      expect(issues(parse({ targetFrom: "2026-02-01", targetTo: "2026-01-31" }))).toEqual([
        { path: "targetTo", message: "validation.dateRangeInvalid" },
      ]);
      expect(parse({ startFrom: "2026-02-01", startTo: "2026-02-01" }).success).toBe(true);
    });

    it("rejects invalid dates, and dates with a time, with the calendarDateInvalid key", () => {
      for (const field of ["startFrom", "startTo", "targetFrom", "targetTo"]) {
        for (const bad of ["2026-02-30", "2026-02-01T10:00:00Z", "yesterday"]) {
          expect(issues(parse({ [field]: bad }))).toEqual([
            { path: field, message: "validation.calendarDateInvalid" },
          ]);
        }
      }
    });

    it("accepts exactly the five sort fields", () => {
      for (const field of ["location", "targetDate", "villaNumber", "progress", "createdAt"]) {
        expect(parse({ sort: field }).success).toBe(true);
        expect(parse({ sort: `${field}:asc` }).success).toBe(true);
        expect(parse({ sort: `${field}:desc` }).success).toBe(true);
      }
      for (const sort of [
        "area",
        "block",
        "plot",
        "startDate",
        "civilEngineer",
        "contractor",
        "status",
        "id:asc",
        "location:up",
        "progress:up",
        ":asc",
        "Location",
      ]) {
        expect(issues(parse({ sort }))).toEqual([{ path: "sort", message: "validation.sortVillasInvalid" }]);
      }
    });

    it("limits search to 100 characters", () => {
      expect(parse({ search: "x".repeat(100) }).success).toBe(true);
      expect(issues(parse({ search: "x".repeat(101) }))).toEqual([
        { path: "search", message: "validation.searchTooLong" },
      ]);
    });
  });
});
