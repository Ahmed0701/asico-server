import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdmin } from "../../prisma/seed/admin.js";
import { seedPermissions } from "../../prisma/seed/permissions.js";
import { PERMISSION_CODES } from "../../src/shared/constants/permissions.js";
import { BCRYPT_COST } from "../../src/shared/constants/security.js";

type Db = Parameters<typeof ensureAdmin>[0] & Parameters<typeof seedPermissions>[0];

const upsert = vi.fn();
const findFirst = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const db = { permission: { upsert }, user: { findFirst, findUnique, create } } as unknown as Db;

const validEnv = { ADMIN_EMAIL: "  Admin@Example.COM ", ADMIN_PASSWORD: "a-long-enough-password" };

beforeEach(() => {
  for (const fn of [upsert, findFirst, findUnique, create]) {
    fn.mockReset();
  }
});

describe("seedPermissions", () => {
  it("upserts every permission code without touching existing rows", async () => {
    await expect(seedPermissions(db)).resolves.toBe(PERMISSION_CODES.length);

    expect(upsert).toHaveBeenCalledTimes(80);
    for (const code of PERMISSION_CODES) {
      expect(upsert).toHaveBeenCalledWith({ where: { code }, update: {}, create: { code } });
    }
  });

  it("seeds the villa codes and none of the removed project and wall piping ones", async () => {
    await seedPermissions(db);

    const codes = upsert.mock.calls.map(([args]) => (args as { where: { code: string } }).where.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "villas:read",
        "villas:export",
        "villas:progress",
        "villas:inspection",
        "villas:import",
        "villa-documents:upload",
      ]),
    );
    expect(codes.filter((code) => /^(projects|project-files|wall-piping):/.test(code))).toEqual([]);
    expect(codes).toEqual(
      expect.arrayContaining(["open-works:read", "open-works:export", "open-works:import"]),
    );
  });

  it("is idempotent: a second run issues the same upserts and never plain creates", async () => {
    await seedPermissions(db);
    const first = upsert.mock.calls.map(([args]) => JSON.stringify(args));
    upsert.mockClear();

    await seedPermissions(db);

    expect(upsert.mock.calls.map(([args]) => JSON.stringify(args))).toEqual(first);
  });
});

describe("ensureAdmin", () => {
  it("does nothing, and needs no ADMIN_* variables, when an admin already exists", async () => {
    findFirst.mockResolvedValue({ id: "existing" });

    await expect(ensureAdmin(db, {})).resolves.toBe("exists");

    expect(findFirst).toHaveBeenCalledWith({ where: { role: "ADMIN" }, select: { id: true } });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates an active ADMIN with a cost-12 bcrypt hash and a normalised email", async () => {
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue(null);

    await expect(ensureAdmin(db, validEnv)).resolves.toBe("created");

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ email: "admin@example.com", role: "ADMIN", isActive: true });
    expect(data["passwordHash"]).not.toBe(validEnv.ADMIN_PASSWORD);
    expect(BCRYPT_COST).toBe(12);
    expect(bcrypt.getRounds(String(data["passwordHash"]))).toBe(12);
    await expect(bcrypt.compare(validEnv.ADMIN_PASSWORD, String(data["passwordHash"]))).resolves.toBe(true);
  });

  it("creates no UserPermission rows for the admin: permissions are implied by the role", async () => {
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue(null);

    await ensureAdmin(db, validEnv);

    const { data } = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty("permissions");
  });

  it.each([
    ["missing variables", {}],
    ["an invalid email", { ADMIN_EMAIL: "not-an-email", ADMIN_PASSWORD: "a-long-enough-password" }],
    ["a password under 12 characters", { ADMIN_EMAIL: "a@x.test", ADMIN_PASSWORD: "short" }],
    ["a password over 72 bytes", { ADMIN_EMAIL: "a@x.test", ADMIN_PASSWORD: "x".repeat(73) }],
  ])("refuses to create an admin from %s, without echoing the password", async (_label, source) => {
    findFirst.mockResolvedValue(null);

    const attempt = ensureAdmin(db, source);

    await expect(attempt).rejects.toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD/);
    await expect(attempt).rejects.not.toThrow(/a-long-enough-password|x{73}/);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when a non-admin user already has that email", async () => {
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue({ id: "employee" });

    await expect(ensureAdmin(db, validEnv)).rejects.toThrow(/already uses ADMIN_EMAIL/);
    expect(create).not.toHaveBeenCalled();
  });
});
