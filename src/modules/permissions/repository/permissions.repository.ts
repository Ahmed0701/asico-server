import { prisma } from "../../../core/database/prisma.js";
import type { Prisma, Role } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

// Thrown when a valid code has no row in the Permission table, which means the seed was not run.
export class MissingPermissionsError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`Permission codes missing from the database (run the seed): ${codes.join(", ")}`);
  }
}

// The only writer of UserPermission rows. Other modules that assign permissions go through it.
export class PermissionsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async listCodes(db: Db = prisma): Promise<string[]> {
    const rows = await db.permission.findMany({ select: { code: true }, orderBy: { code: "asc" } });
    return rows.map((row) => row.code);
  }

  findUser(id: string, db: Db = prisma): Promise<{ id: string; role: Role } | null> {
    return db.user.findUnique({ where: { id }, select: { id: true, role: true } });
  }

  async getUserCodes(userId: string, db: Db = prisma): Promise<string[]> {
    const grants = await db.userPermission.findMany({
      where: { userId },
      select: { permission: { select: { code: true } } },
    });
    return grants.map((grant) => grant.permission.code).sort();
  }

  // Makes the user's set exactly `codes`. Only the difference is written, so unchanged grants keep their
  // `grantedAt`. Requires a transaction client so the read and the writes cannot interleave with another change.
  async setUserCodes(
    userId: string,
    codes: readonly string[],
    db: Db,
  ): Promise<{ before: string[]; after: string[] }> {
    const before = await this.getUserCodes(userId, db);
    const after = [...new Set(codes)].sort();
    const toAdd = after.filter((code) => !before.includes(code));
    const toRemove = before.filter((code) => !after.includes(code));
    if (toAdd.length === 0 && toRemove.length === 0) {
      return { before, after };
    }

    const rows = await db.permission.findMany({
      where: { code: { in: [...toAdd, ...toRemove] } },
      select: { id: true, code: true },
    });
    const idOf = new Map(rows.map((row) => [row.code, row.id]));
    const missing = toAdd.filter((code) => !idOf.has(code));
    if (missing.length > 0) {
      throw new MissingPermissionsError(missing);
    }

    if (toRemove.length > 0) {
      await db.userPermission.deleteMany({
        where: { userId, permissionId: { in: toRemove.flatMap((code) => idOf.get(code) ?? []) } },
      });
    }
    if (toAdd.length > 0) {
      await db.userPermission.createMany({
        data: toAdd.flatMap((code) => {
          const permissionId = idOf.get(code);
          return permissionId === undefined ? [] : [{ userId, permissionId }];
        }),
      });
    }
    return { before, after };
  }
}
