import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma, User } from "../../../generated/prisma/client.js";
import { cleanWhere, escapeLike } from "../../../shared/query/where.js";
import type { UserFilters, UserSort } from "../dto/users.dto.js";

export type Db = Prisma.TransactionClient;

type ListParams = { filters: UserFilters; sort: UserSort; skip: number; take: number };

function whereOf({ role, isActive, search }: UserFilters): Prisma.UserWhereInput {
  // cleanWhere has already dropped the filters that were not sent, so the cast only removes `| undefined`.
  const exact = cleanWhere({ role, isActive }) as Prisma.UserWhereInput;
  if (!search) {
    return exact;
  }
  const term = escapeLike(search);
  return {
    ...exact,
    OR: [
      { name: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ],
  };
}

// `id` breaks ties so pages never repeat or skip rows when the sort column has duplicates.
function orderByOf({ field, direction }: UserSort): Prisma.UserOrderByWithRelationInput[] {
  switch (field) {
    case "name":
      return [{ name: direction }, { id: "asc" }];
    case "email":
      return [{ email: direction }, { id: "asc" }];
    case "role":
      return [{ role: direction }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: direction }, { id: "asc" }];
  }
}

export class UsersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ users: User[]; total: number }> {
    const where = whereOf(filters);
    const [users, total] = await Promise.all([
      db.user.findMany({ where, orderBy: orderByOf(sort), skip, take }),
      db.user.count({ where }),
    ]);
    return { users, total };
  }

  findById(id: string, db: Db = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  findByEmail(email: string, db: Db = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { email } });
  }

  // Role is fixed here on purpose: the single ADMIN is created by the seed, never through the API.
  createUser(
    data: { name: string; email: string; passwordHash: string; isActive: boolean },
    db: Db = prisma,
  ): Promise<User> {
    return db.user.create({ data: { ...data, role: "EMPLOYEE" } });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such user).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "User", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async updateUser(
    id: string,
    version: number,
    data: { name?: string; email?: string },
    db: Db = prisma,
  ): Promise<User | null> {
    const { count } = await db.user.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.user.findUnique({ where: { id } }) : null;
  }

  async setActive(id: string, version: number, isActive: boolean, db: Db = prisma): Promise<User | null> {
    const { count } = await db.user.updateMany({
      where: { id, version },
      data: { isActive, version: { increment: 1 } },
    });
    return count === 1 ? db.user.findUnique({ where: { id } }) : null;
  }

  // What a user created that must keep its author: villas and villa documents. Such a user is deactivated, not deleted.
  async countAuthoredRecords(id: string, db: Db = prisma): Promise<number> {
    const [villas, documents] = await Promise.all([
      db.villa.count({ where: { createdById: id } }),
      db.villaDocument.count({ where: { uploadedById: id } }),
    ]);
    return villas + documents;
  }

  // Compare-and-set on the version. Their permissions, sessions and notifications go with them (ON DELETE CASCADE); the
  // records that name them as author or marker keep the record and lose the name (ON DELETE SET NULL).
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.user.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async revokeUserRefreshTokens(userId: string, now: Date, db: Db = prisma): Promise<void> {
    await db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  }
}
