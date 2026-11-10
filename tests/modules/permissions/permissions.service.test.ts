import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { toPermissionGroups } from "../../../src/modules/permissions/mapper/permissions.mapper.js";
import type {
  Db,
  PermissionsRepository,
} from "../../../src/modules/permissions/repository/permissions.repository.js";
import { PermissionsService } from "../../../src/modules/permissions/service/permissions.service.js";
import { PERMISSION_CODES } from "../../../src/shared/constants/permissions.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const tx = { marker: "tx" } as unknown as Db;
const adminActor: Actor = { id: "admin-1", role: "ADMIN" };
const employeeActor: Actor = { id: "emp-actor", role: "EMPLOYEE" };

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    listCodes: vi.fn(),
    findUser: vi.fn(),
    getUserCodes: vi.fn(),
    setUserCodes: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let service: PermissionsService;

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
  service = new PermissionsService(repo as unknown as PermissionsRepository);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toPermissionGroups", () => {
  it("groups codes by resource, with resources and codes sorted", () => {
    expect(toPermissionGroups(["users:read", "villas:update", "villas:read", "audit:read"])).toEqual([
      { resource: "audit", permissions: ["audit:read"] },
      { resource: "users", permissions: ["users:read"] },
      { resource: "villas", permissions: ["villas:read", "villas:update"] },
    ]);
  });

  it("groups all 80 real codes into the 18 resources", () => {
    const groups = toPermissionGroups(PERMISSION_CODES);

    expect(groups.map((group) => group.resource)).toEqual([
      "areas",
      "audit",
      "civil-engineers",
      "contractors",
      "daily-labour",
      "daily-reports",
      "dashboard",
      "elec-phases",
      "electrical-engineers",
      "maintenance",
      "materials",
      "open-works",
      "permissions",
      "site-reports",
      "small-works",
      "users",
      "villa-documents",
      "villas",
    ]);
    expect(groups.flatMap((group) => group.permissions)).toHaveLength(80);
  });
});

describe("list", () => {
  it("returns the codes in the database grouped by resource", async () => {
    repo.listCodes.mockResolvedValue(["villas:read", "users:read", "villas:create"]);

    await expect(service.list()).resolves.toEqual([
      { resource: "users", permissions: ["users:read"] },
      { resource: "villas", permissions: ["villas:create", "villas:read"] },
    ]);
  });
});

describe("getForUser", () => {
  it("answers 404 USER_NOT_FOUND, translated", async () => {
    repo.findUser.mockResolvedValue(null);

    expect(await failure(service.getForUser("missing", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
      message: "المستخدم غير موجود",
    });
  });

  it("returns an EMPLOYEE's granted codes", async () => {
    repo.findUser.mockResolvedValue({ id: "u1", role: "EMPLOYEE" });
    repo.getUserCodes.mockResolvedValue(["villas:read"]);

    await expect(service.getForUser("u1", ctx)).resolves.toEqual({
      userId: "u1",
      permissions: ["villas:read"],
    });
  });

  it("returns every code for the ADMIN, without reading rows that do not exist", async () => {
    repo.findUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" });

    const result = await service.getForUser("admin-1", ctx);

    expect(result.permissions).toEqual([...PERMISSION_CODES]);
    expect(repo.getUserCodes).not.toHaveBeenCalled();
  });
});

describe("replaceForUser", () => {
  beforeEach(() => {
    repo.findUser.mockResolvedValue({ id: "u1", role: "EMPLOYEE" });
    repo.setUserCodes.mockResolvedValue({
      before: ["villas:read"],
      after: ["contractors:read", "users:read"],
    });
  });

  it("answers 404 for an unknown user", async () => {
    repo.findUser.mockResolvedValue(null);

    expect(await failure(service.replaceForUser(adminActor, "x", [], ctx))).toMatchObject({
      code: "USER_NOT_FOUND",
    });
    expect(repo.setUserCodes).not.toHaveBeenCalled();
  });

  it("replaces the set and audits the codes before and after, in the same transaction", async () => {
    const result = await service.replaceForUser(adminActor, "u1", ["users:read", "contractors:read"], ctx);

    expect(repo.setUserCodes).toHaveBeenCalledWith("u1", ["users:read", "contractors:read"], tx);
    expect(result).toEqual({ userId: "u1", permissions: ["contractors:read", "users:read"] });
    expect(vi.mocked(audit.record).mock.calls[0]?.[0]).toBe(tx);
    expect(vi.mocked(audit.record).mock.calls[0]?.[1]).toMatchObject({
      action: "user.permissions_replaced",
      entity: "User",
      actorId: "admin-1",
      entityId: "u1",
      before: { permissions: ["villas:read"] },
      after: { permissions: ["contractors:read", "users:read"] },
      requestId: "req-1",
    });
    expect(repo.transaction).toHaveBeenCalledTimes(1);
  });

  it("still audits when nothing changes, because the action was performed", async () => {
    repo.setUserCodes.mockResolvedValue({ before: [], after: [] });

    await service.replaceForUser(adminActor, "u1", [], ctx);

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("refuses to change the ADMIN's permissions, whoever asks", async () => {
    repo.findUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" });

    const byEmployee = await failure(service.replaceForUser(employeeActor, "admin-1", [], ctxAr));
    const bySelf = await failure(service.replaceForUser(adminActor, "admin-1", [], ctx));

    expect(byEmployee).toMatchObject({
      statusCode: 403,
      code: "ADMIN_PERMISSIONS_IMMUTABLE",
      message: "لا يمكن تغيير صلاحيات المسؤول",
    });
    expect(bySelf.code).toBe("ADMIN_PERMISSIONS_IMMUTABLE");
    expect(repo.setUserCodes).not.toHaveBeenCalled();
  });

  it("stops an employee from changing their own permissions", async () => {
    repo.findUser.mockResolvedValue({ id: "emp-actor", role: "EMPLOYEE" });

    const err = await failure(service.replaceForUser(employeeActor, "emp-actor", ["users:read"], ctxAr));

    expect(err).toMatchObject({
      statusCode: 403,
      code: "CANNOT_MODIFY_OWN_PERMISSIONS",
      message: "لا يمكنك تغيير صلاحياتك الخاصة",
    });
    expect(repo.setUserCodes).not.toHaveBeenCalled();
  });

  it("lets an employee holding the permission change someone else's", async () => {
    await expect(service.replaceForUser(employeeActor, "u1", ["users:read"], ctx)).resolves.toBeDefined();
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.replaceForUser(adminActor, "u1", ["users:read"], ctx)).rejects.toThrow("audit down");
  });

  it("lets a missing-seed error through so it surfaces as a 500, not a partial write", async () => {
    repo.setUserCodes.mockRejectedValue(
      new Error("Permission codes missing from the database (run the seed)"),
    );

    await expect(service.replaceForUser(adminActor, "u1", ["users:read"], ctx)).rejects.toThrow(
      "run the seed",
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
