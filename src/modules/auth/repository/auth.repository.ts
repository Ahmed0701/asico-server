import { prisma } from "../../../core/database/prisma.js";
import type { Prisma, Role, User } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

export type RefreshTokenRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  // The token that took this one's place when a refresh spent it; null for any other kind of revocation.
  replacedById: string | null;
  user: { id: string; role: Role; isActive: boolean };
};

export type ResetTokenRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
};

type NewRefreshToken = { userId: string; tokenHash: string; expiresAt: Date };
type NewResetToken = { userId: string; tokenHash: string; expiresAt: Date };

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

// Every method takes the client to use, so the service can run several of them in one transaction.
export class AuthRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  findUserByEmail(email: string, db: Db = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { email } });
  }

  findUserById(id: string, db: Db = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  createUser(data: { name: string; email: string; passwordHash: string }, db: Db = prisma): Promise<User> {
    return db.user.create({ data: { ...data, role: "EMPLOYEE", isActive: false } });
  }

  updateUserName(id: string, name: string, db: Db = prisma): Promise<User> {
    return db.user.update({ where: { id }, data: { name, version: { increment: 1 } } });
  }

  async updateUserPassword(id: string, passwordHash: string, db: Db = prisma): Promise<void> {
    await db.user.update({ where: { id }, data: { passwordHash, version: { increment: 1 } } });
  }

  async getPermissionCodes(userId: string, db: Db = prisma): Promise<string[]> {
    const grants = await db.userPermission.findMany({
      where: { userId },
      select: { permission: { select: { code: true } } },
    });
    return grants.map((grant) => grant.permission.code).sort();
  }

  async createRefreshToken(data: NewRefreshToken, db: Db = prisma): Promise<void> {
    await db.refreshToken.create({ data });
  }

  findRefreshTokenByHash(tokenHash: string, db: Db = prisma): Promise<RefreshTokenRecord | null> {
    return db.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
        user: { select: { id: true, role: true, isActive: true } },
      },
    });
  }

  // Atomic: only one of several concurrent callers sees `true` for the same token.
  async revokeRefreshToken(id: string, now: Date, db: Db = prisma): Promise<boolean> {
    const { count } = await db.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return count === 1;
  }

  // Spends a token and issues its successor, as one unit: only one of several concurrent callers wins the token
  // (the others get `false` and have changed nothing), and the winner's new token is created and linked from the
  // old one. Run it in a transaction.
  async rotateRefreshToken(id: string, now: Date, next: NewRefreshToken, db: Db = prisma): Promise<boolean> {
    if (!(await this.revokeRefreshToken(id, now, db))) {
      return false;
    }
    const created = await db.refreshToken.create({ data: next, select: { id: true } });
    await db.refreshToken.update({ where: { id }, data: { replacedById: created.id } });
    return true;
  }

  async revokeUserRefreshTokens(
    userId: string,
    now: Date,
    options: { exceptId?: string | undefined } = {},
    db: Db = prisma,
  ): Promise<void> {
    await db.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptId !== undefined && { id: { not: options.exceptId } }),
      },
      data: { revokedAt: now },
    });
  }

  // When the newest reset token that is still usable was issued, or null if there is none.
  async latestOpenResetTokenAt(userId: string, now: Date, db: Db = prisma): Promise<Date | null> {
    const latest = await db.passwordResetToken.findFirst({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return latest?.createdAt ?? null;
  }

  async createResetToken(data: NewResetToken, db: Db = prisma): Promise<void> {
    await db.passwordResetToken.create({ data });
  }

  findResetTokenByHash(tokenHash: string, db: Db = prisma): Promise<ResetTokenRecord | null> {
    return db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
  }

  // Atomic: a reset token can be spent once, even under concurrent requests.
  async useResetToken(id: string, now: Date, db: Db = prisma): Promise<boolean> {
    const { count } = await db.passwordResetToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    });
    return count === 1;
  }

  async useAllResetTokens(userId: string, now: Date, db: Db = prisma): Promise<void> {
    await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  }
}
