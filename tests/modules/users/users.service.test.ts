import bcrypt from "bcrypt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import type { User } from "../../../src/generated/prisma/client.js";
import type { PermissionsRepository } from "../../../src/modules/permissions/repository/permissions.repository.js";
import type { Db, UsersRepository } from "../../../src/modules/users/repository/users.repository.js";
import { UsersService } from "../../../src/modules/users/service/users.service.js";
import type { ListUsersQuery } from "../../../src/modules/users/validators/users.validators.js";
import { PERMISSION_CODES } from "../../../src/shared/constants/permissions.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const tx = { marker: "tx" } as unknown as Db;
const adminActor: Actor = { id: "admin-1", role: "ADMIN" };
const employeeActor: Actor = { id: "emp-actor", role: "EMPLOYEE" };

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    name: "Sara",
    email: "sara@example.test",
    passwordHash: "$2b$12$not-a-real-hash-not-a-real-hash-not-a-real-hash-1234",
    role: "EMPLOYEE",
    isActive: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRepos() {
  const users = {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    list: vi.fn(),
    findById: vi.fn(),
    lockVersion: vi.fn(),
    findByEmail: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    setActive: vi.fn(),
    revokeUserRefreshTokens: vi.fn(),
  };
  const permissions = { getUserCodes: vi.fn(), setUserCodes: vi.fn() };
  return { users, permissions };
}
type Repos = ReturnType<typeof makeRepos>;

let repos: Repos;
let service: UsersService;
const auditCalls = () => vi.mocked(audit.record).mock.calls;
const auditEntry = (index = 0) => auditCalls()[index]?.[1];

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
  repos = makeRepos();
  repos.users.lockVersion.mockResolvedValue(1);
  service = new UsersService(
    repos.users as unknown as UsersRepository,
    repos.permissions as unknown as PermissionsRepository,
    () => NOW,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const query = (overrides: Partial<ListUsersQuery> = {}): ListUsersQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe("list", () => {
  it("defaults to newest first, page 1, 20 per page, and returns DTOs without password hashes", async () => {
    repos.users.list.mockResolvedValue({ users: [makeUser(), makeUser({ id: "user-2" })], total: 45 });

    const result = await service.list(query());

    expect(repos.users.list).toHaveBeenCalledWith({
      filters: { role: undefined, isActive: undefined, search: undefined },
      sort: { field: "createdAt", direction: "desc" },
      skip: 0,
      take: 20,
    });
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.users).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|\$2b\$/);
  });

  it("passes filters, search, sort and the page window through", async () => {
    repos.users.list.mockResolvedValue({ users: [], total: 0 });

    await service.list(
      query({ page: 3, limit: 50, role: "EMPLOYEE", isActive: false, search: "sara", sort: "email:asc" }),
    );

    expect(repos.users.list).toHaveBeenCalledWith({
      filters: { role: "EMPLOYEE", isActive: false, search: "sara" },
      sort: { field: "email", direction: "asc" },
      skip: 100,
      take: 50,
    });
  });

  it.each([
    ["name", { field: "name", direction: "asc" }],
    ["role:desc", { field: "role", direction: "desc" }],
    ["createdAt:asc", { field: "createdAt", direction: "asc" }],
    ["password:asc", { field: "createdAt", direction: "desc" }],
  ])(
    "maps sort %j to %j, falling back to the default for anything off the whitelist",
    async (sort, expected) => {
      repos.users.list.mockResolvedValue({ users: [], total: 0 });

      await service.list(query({ sort }));

      expect(repos.users.list.mock.calls[0]?.[0].sort).toEqual(expected);
    },
  );

  it("reports one empty page when there are no users", async () => {
    repos.users.list.mockResolvedValue({ users: [], total: 0 });

    expect((await service.list(query())).meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });
});

describe("get", () => {
  it("answers 404 USER_NOT_FOUND, translated", async () => {
    repos.users.findById.mockResolvedValue(null);

    const err = await failure(service.get("missing", ctxAr));

    expect(err).toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND", message: "المستخدم غير موجود" });
  });

  it("returns an EMPLOYEE with the codes granted in the database", async () => {
    repos.users.findById.mockResolvedValue(makeUser());
    repos.permissions.getUserCodes.mockResolvedValue(["villas:read"]);

    const me = await service.get("user-1", ctx);

    expect(me).toMatchObject({ id: "user-1", permissions: ["villas:read"] });
    expect(me).not.toHaveProperty("passwordHash");
  });

  it("gives the ADMIN every code without reading the database", async () => {
    repos.users.findById.mockResolvedValue(makeUser({ role: "ADMIN" }));

    const me = await service.get("user-1", ctx);

    expect(me.permissions).toEqual([...PERMISSION_CODES]);
    expect(repos.permissions.getUserCodes).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  const input = {
    name: "New Person",
    email: "new@example.test",
    password: "Correct-Horse-9",
    isActive: true,
    permissions: ["villas:read", "contractors:read"] as ("villas:read" | "contractors:read")[],
  };

  beforeEach(() => {
    repos.users.findByEmail.mockResolvedValue(null);
    repos.users.createUser.mockImplementation(async (data: Record<string, unknown>) =>
      makeUser({ id: "new-user", ...data, role: "EMPLOYEE" }),
    );
    repos.permissions.setUserCodes.mockImplementation(async (_id: string, codes: string[]) => ({
      before: [],
      after: [...codes].sort(),
    }));
  });

  it("creates an EMPLOYEE with a cost-12 hash, its permission rows and its audit row in one transaction", async () => {
    const dto = await service.create(adminActor, input, ctx);

    const [data, createTx] = repos.users.createUser.mock.calls[0] as [
      { name: string; email: string; passwordHash: string; isActive: boolean },
      Db,
    ];
    expect(createTx).toBe(tx);
    expect(data).toMatchObject({ name: "New Person", email: "new@example.test", isActive: true });
    expect(data.passwordHash).not.toBe(input.password);
    expect(bcrypt.getRounds(data.passwordHash)).toBe(12);
    await expect(bcrypt.compare(input.password, data.passwordHash)).resolves.toBe(true);

    expect(repos.permissions.setUserCodes).toHaveBeenCalledWith("new-user", input.permissions, tx);
    expect(dto).toMatchObject({
      id: "new-user",
      role: "EMPLOYEE",
      permissions: ["contractors:read", "villas:read"],
    });
    expect(dto).not.toHaveProperty("passwordHash");
    expect(repos.users.transaction).toHaveBeenCalledTimes(1);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "user.create",
      entity: "User",
      actorId: "admin-1",
      entityId: "new-user",
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
      after: {
        name: "New Person",
        email: "new@example.test",
        role: "EMPLOYEE",
        isActive: true,
        permissions: ["contractors:read", "villas:read"],
      },
    });
  });

  it("lets only an ADMIN or a holder of permissions:assign grant permissions while creating", async () => {
    repos.permissions.getUserCodes.mockResolvedValueOnce(["users:create"]);
    const denied = await failure(service.create(employeeActor, input, ctxAr));

    expect(denied).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_ASSIGN_REQUIRED",
      message: "غير مسموح",
    });
    expect(repos.users.createUser).not.toHaveBeenCalled();
    expect(repos.users.findByEmail).not.toHaveBeenCalled();

    repos.permissions.getUserCodes.mockResolvedValueOnce(["users:create", "permissions:assign"]);
    await expect(service.create(employeeActor, input, ctx)).resolves.toBeDefined();

    repos.permissions.getUserCodes.mockClear();
    await expect(service.create(adminActor, input, ctx)).resolves.toBeDefined();
    expect(repos.permissions.getUserCodes).not.toHaveBeenCalled();
  });

  it("needs no permissions:assign when the new user gets no permissions", async () => {
    await expect(service.create(employeeActor, { ...input, permissions: [] }, ctx)).resolves.toBeDefined();

    expect(repos.permissions.getUserCodes).not.toHaveBeenCalled();
  });

  it("can create the user inactive, and always as EMPLOYEE", async () => {
    await service.create(adminActor, { ...input, isActive: false, permissions: [] }, ctx);

    expect(repos.users.createUser.mock.calls[0]?.[0]).toMatchObject({ isActive: false });
    expect(Object.keys(repos.users.createUser.mock.calls[0]?.[0] as object)).not.toContain("role");
  });

  it("rejects a taken email with 409 before hashing anything", async () => {
    repos.users.findByEmail.mockResolvedValue(makeUser());
    const hash = vi.spyOn(bcrypt, "hash");

    const err = await failure(service.create(adminActor, input, ctxAr));

    expect(err).toMatchObject({ statusCode: 409, code: "EMAIL_TAKEN" });
    expect(hash).not.toHaveBeenCalled();
    expect(repos.users.createUser).not.toHaveBeenCalled();
  });

  it("turns a unique-index race into the same 409", async () => {
    repos.users.createUser.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    expect(await failure(service.create(adminActor, input, ctx))).toMatchObject({
      statusCode: 409,
      code: "EMAIL_TAKEN",
    });
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.create(adminActor, input, ctx)).rejects.toThrow("audit down");
  });

  it("lets an unexpected permission error through unchanged", async () => {
    repos.permissions.setUserCodes.mockRejectedValue(new Error("Permission codes missing from the database"));

    await expect(service.create(adminActor, input, ctx)).rejects.toThrow("missing from the database");
  });

  it("never puts the password or its hash in the audit entry", async () => {
    await service.create(adminActor, input, ctx);

    const serialised = JSON.stringify(auditCalls().map(([, entry]) => entry));
    expect(serialised).not.toContain(input.password);
    expect(serialised).not.toContain(repos.users.createUser.mock.calls[0]?.[0].passwordHash);
    expect(serialised).not.toMatch(/\$2b\$/);
  });
});

describe("update", () => {
  beforeEach(() => {
    repos.users.findById.mockResolvedValue(makeUser());
    repos.users.findByEmail.mockResolvedValue(null);
    repos.users.updateUser.mockImplementation(
      async (_id: string, _version: number, data: Record<string, unknown>) => makeUser(data as Partial<User>),
    );
  });

  it("answers 404 for an unknown user", async () => {
    repos.users.findById.mockResolvedValue(null);

    expect(await failure(service.update(adminActor, "x", { name: "N" }, ctx))).toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });

  it("changes only the fields that were sent and audits before and after", async () => {
    const dto = await service.update(adminActor, "user-1", { name: "Sara K" }, ctx);

    expect(repos.users.updateUser).toHaveBeenCalledWith("user-1", 1, { name: "Sara K" }, tx);
    expect(dto).toMatchObject({ name: "Sara K", email: "sara@example.test" });
    expect(auditEntry()).toMatchObject({
      action: "user.update",
      actorId: "admin-1",
      entityId: "user-1",
      before: { name: "Sara", email: "sara@example.test" },
      after: { name: "Sara K", email: "sara@example.test" },
    });
  });

  it("rejects an email that belongs to someone else with 409", async () => {
    repos.users.findByEmail.mockResolvedValue(makeUser({ id: "other" }));

    const err = await failure(service.update(adminActor, "user-1", { email: "taken@example.test" }, ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "EMAIL_TAKEN" });
    expect(repos.users.updateUser).not.toHaveBeenCalled();
  });

  it("does not look up or conflict on the user's own current email", async () => {
    await service.update(adminActor, "user-1", { email: "sara@example.test", name: "Sara K" }, ctx);

    expect(repos.users.findByEmail).not.toHaveBeenCalled();
    expect(repos.users.updateUser).toHaveBeenCalled();
  });

  it("turns a unique-index race into 409", async () => {
    repos.users.updateUser.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    expect(
      await failure(service.update(adminActor, "user-1", { email: "new@example.test" }, ctx)),
    ).toMatchObject({
      statusCode: 409,
    });
  });

  it("protects the ADMIN account from everyone but the ADMIN", async () => {
    repos.users.findById.mockResolvedValue(makeUser({ id: "admin-1", role: "ADMIN" }));

    const denied = await failure(
      service.update(employeeActor, "admin-1", { email: "mine@example.test" }, ctxAr),
    );
    await service.update(adminActor, "admin-1", { name: "Root" }, ctx);

    expect(denied).toMatchObject({
      statusCode: 403,
      code: "ADMIN_ACCOUNT_PROTECTED",
      message: "لا يمكن إلا للمسؤول تعديل حساب المسؤول",
    });
    expect(repos.users.updateUser).toHaveBeenCalledTimes(1);
  });

  it("never lets the role be part of the update", async () => {
    await service.update(adminActor, "user-1", { name: "Sara K", email: "new@example.test" }, ctx);

    expect(Object.keys(repos.users.updateUser.mock.calls[0]?.[2] as object).sort()).toEqual([
      "email",
      "name",
    ]);
  });
});

describe("activate", () => {
  it("answers 404 for an unknown user", async () => {
    repos.users.findById.mockResolvedValue(null);

    expect(await failure(service.activate(adminActor, "x", ctx))).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("activates inside a transaction and audits before and after", async () => {
    repos.users.findById.mockResolvedValue(makeUser({ isActive: false }));
    repos.users.setActive.mockResolvedValue(makeUser({ isActive: true }));

    const dto = await service.activate(adminActor, "user-1", ctx);

    expect(repos.users.setActive).toHaveBeenCalledWith("user-1", 1, true, tx);
    expect(dto.isActive).toBe(true);
    expect(auditEntry()).toMatchObject({
      action: "user.activate",
      actorId: "admin-1",
      before: { isActive: false },
      after: { isActive: true },
    });
  });
});

describe("deactivate", () => {
  beforeEach(() => {
    repos.users.findById.mockResolvedValue(makeUser());
    repos.users.setActive.mockResolvedValue(makeUser({ isActive: false }));
  });

  it("answers 404 for an unknown user", async () => {
    repos.users.findById.mockResolvedValue(null);

    expect(await failure(service.deactivate(adminActor, "x", ctx))).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("deactivates, revokes every refresh token and audits, all in the same transaction", async () => {
    const dto = await service.deactivate(adminActor, "user-1", ctx);

    expect(dto.isActive).toBe(false);
    expect(repos.users.setActive).toHaveBeenCalledWith("user-1", 1, false, tx);
    expect(repos.users.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditEntry()).toMatchObject({
      action: "user.deactivate",
      actorId: "admin-1",
      before: { isActive: true },
      after: { isActive: false },
    });
    expect(repos.users.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to deactivate the ADMIN, whoever asks, even if it is themselves", async () => {
    repos.users.findById.mockResolvedValue(makeUser({ id: "admin-1", role: "ADMIN" }));

    const byEmployee = await failure(service.deactivate(employeeActor, "admin-1", ctxAr));
    const bySelf = await failure(service.deactivate(adminActor, "admin-1", ctx));

    expect(byEmployee).toMatchObject({
      statusCode: 403,
      code: "ADMIN_CANNOT_BE_DEACTIVATED",
      message: "لا يمكن تعطيل حساب المسؤول",
    });
    expect(bySelf.code).toBe("ADMIN_CANNOT_BE_DEACTIVATED");
    expect(repos.users.setActive).not.toHaveBeenCalled();
  });

  it("refuses to let a user deactivate themselves", async () => {
    repos.users.findById.mockResolvedValue(makeUser({ id: "emp-actor" }));

    const err = await failure(service.deactivate(employeeActor, "emp-actor", ctxAr));

    expect(err).toMatchObject({
      statusCode: 403,
      code: "CANNOT_DEACTIVATE_SELF",
      message: "لا يمكنك تعطيل حسابك الخاص",
    });
    expect(repos.users.setActive).not.toHaveBeenCalled();
    expect(repos.users.revokeUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("fails as a whole when the audit write fails", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(service.deactivate(adminActor, "user-1", ctx)).rejects.toThrow("audit down");
  });
});
