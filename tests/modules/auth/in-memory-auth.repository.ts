import { randomUUID } from "node:crypto";
import { Serial } from "../../helpers/serial.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { materialTables } from "../materials/material-tables.js";
import { siteReportTables } from "../site-reports/site-report-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import type { Role, User } from "../../../src/generated/prisma/client.js";
import type {
  AuthRepository,
  Db,
  RefreshTokenRecord,
  ResetTokenRecord,
} from "../../../src/modules/auth/repository/auth.repository.js";

type StoredRefreshToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  createdAt: Date;
};
type StoredResetToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};
type Grant = { userId: string; code: string };

type Snapshot = {
  users: User[];
  refreshTokens: StoredRefreshToken[];
  resetTokens: StoredResetToken[];
  auditRows: Record<string, unknown>[];
};

// Plain-memory stand-in for the tables the auth module touches. Tests seed it and inspect it directly.
export const store = {
  users: [] as User[],
  refreshTokens: [] as StoredRefreshToken[],
  resetTokens: [] as StoredResetToken[],
  grants: [] as Grant[],
  auditRows: [] as Record<string, unknown>[],
  failAuditWith: null as Error | null,

  reset(): void {
    this.users = [];
    this.refreshTokens = [];
    this.resetTokens = [];
    this.grants = [];
    this.auditRows = [];
    this.failAuditWith = null;
  },

  snapshot(): Snapshot {
    return structuredClone({
      users: this.users,
      refreshTokens: this.refreshTokens,
      resetTokens: this.resetTokens,
      auditRows: this.auditRows,
    });
  },

  restore(snapshot: Snapshot): void {
    this.users = snapshot.users;
    this.refreshTokens = snapshot.refreshTokens;
    this.resetTokens = snapshot.resetTokens;
    this.auditRows = snapshot.auditRows;
  },

  addUser(overrides: Partial<User> & { email: string; passwordHash: string }): User {
    const now = new Date();
    const user: User = {
      id: randomUUID(),
      name: "Test User",
      role: "EMPLOYEE",
      isActive: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.users.push(user);
    return user;
  },

  grant(userId: string, ...codes: string[]): void {
    for (const code of codes) {
      this.grants.push({ userId, code });
    }
  },
};

// Prisma hands back copies; returning live objects would hide bugs that depend on that.
function copyOf(user: User | undefined): User | null {
  return user ? { ...user } : null;
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

// The transaction client handed to audit.record. Rows go into the store, so a rollback removes them.
const fakeTx = {
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }): Promise<void> => {
      if (store.failAuditWith) {
        throw store.failAuditWith;
      }
      store.auditRows.push({ id: randomUUID(), createdAt: new Date(), ...data });
    },
    // Many rows in one statement: all of them, or (when the audit is set to fail) none.
    createMany: async ({ data }: { data: Record<string, unknown>[] }): Promise<{ count: number }> => {
      if (store.failAuditWith) {
        throw store.failAuditWith;
      }
      for (const row of data) {
        store.auditRows.push({ id: randomUUID(), createdAt: new Date(), ...row });
      }
      return { count: data.length };
    },
  },
  // What the villas and the elec phases count through the transaction client (open-works/repository/work-item-rows.ts).
  workItem: {
    count: async ({ where }: { where: Parameters<typeof workItemTables.count>[0] }): Promise<number> =>
      workItemTables.count(where),
  },
  // What the villas count of the daily reports (daily-reports/repository/daily-report-rows.ts).
  dailyReport: {
    count: async ({ where }: { where: Parameters<typeof dailyReportTables.count>[0] }): Promise<number> =>
      dailyReportTables.count(where),
  },
  // What the villas count of the daily small works (small-works/repository/small-work-rows.ts).
  dailySmallWork: {
    count: async ({ where }: { where: Parameters<typeof smallWorkTables.count>[0] }): Promise<number> =>
      smallWorkTables.count(where),
  },
  // What the villas count of the site reports (site-reports/repository/site-report-rows.ts).
  siteReport: {
    count: async ({ where }: { where: Parameters<typeof siteReportTables.count>[0] }): Promise<number> =>
      siteReportTables.count(where),
  },
  // What the villas count of the daily labour (daily-labour/repository/daily-labour-rows.ts).
  dailyLabour: {
    count: async ({ where }: { where: Parameters<typeof dailyLabourTables.count>[0] }): Promise<number> =>
      dailyLabourTables.count(where),
  },
  // What the villas count of the material deliveries (materials/repository/material-delivery-rows.ts).
  materialDelivery: {
    count: async ({ where }: { where: Parameters<typeof materialTables.count>[0] }): Promise<number> =>
      materialTables.count(where),
  },
} as unknown as Db;

// Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
export const transactionLock = new Serial();

export class InMemoryAuthRepository implements AuthRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.rawTransaction(work));
  }

  // Without the turn-taking: for the other fakes, which take their turn themselves and then come here.
  async rawTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const snapshot = store.snapshot();
    try {
      return await work(fakeTx);
    } catch (err) {
      store.restore(snapshot);
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return copyOf(store.users.find((user) => user.email === email));
  }

  async findUserById(id: string): Promise<User | null> {
    return copyOf(store.users.find((user) => user.id === id));
  }

  async createUser(data: { name: string; email: string; passwordHash: string }): Promise<User> {
    if (store.users.some((user) => user.email === data.email)) {
      throw uniqueViolation();
    }
    return store.addUser({ ...data, role: "EMPLOYEE", isActive: false });
  }

  async updateUserName(id: string, name: string): Promise<User> {
    const user = store.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error("not found");
    }
    user.name = name;
    user.version += 1;
    return { ...user };
  }

  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    const user = store.users.find((candidate) => candidate.id === id);
    if (user) {
      user.passwordHash = passwordHash;
      user.version += 1;
    }
  }

  async getPermissionCodes(userId: string): Promise<string[]> {
    return store.grants
      .filter((grant) => grant.userId === userId)
      .map((grant) => grant.code)
      .sort();
  }

  async createRefreshToken(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    store.refreshTokens.push({
      id: randomUUID(),
      revokedAt: null,
      replacedById: null,
      createdAt: new Date(),
      ...data,
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const token = store.refreshTokens.find((candidate) => candidate.tokenHash === tokenHash);
    const user = token && store.users.find((candidate) => candidate.id === token.userId);
    if (!token || !user) {
      return null;
    }
    const role: Role = user.role;
    return {
      id: token.id,
      userId: token.userId,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      replacedById: token.replacedById,
      user: { id: user.id, role, isActive: user.isActive },
    };
  }

  async revokeRefreshToken(id: string, now: Date): Promise<boolean> {
    const token = store.refreshTokens.find((candidate) => candidate.id === id);
    if (!token || token.revokedAt) {
      return false;
    }
    token.revokedAt = now;
    return true;
  }

  async rotateRefreshToken(
    id: string,
    now: Date,
    next: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<boolean> {
    if (!(await this.revokeRefreshToken(id, now))) {
      return false;
    }
    const created = { id: randomUUID(), revokedAt: null, replacedById: null, createdAt: now, ...next };
    store.refreshTokens.push(created);
    const old = store.refreshTokens.find((candidate) => candidate.id === id);
    if (old) {
      old.replacedById = created.id;
    }
    return true;
  }

  async revokeUserRefreshTokens(
    userId: string,
    now: Date,
    options: { exceptId?: string | undefined } = {},
  ): Promise<void> {
    for (const token of store.refreshTokens) {
      if (token.userId === userId && !token.revokedAt && token.id !== options.exceptId) {
        token.revokedAt = now;
      }
    }
  }

  async latestOpenResetTokenAt(userId: string, now: Date): Promise<Date | null> {
    const open = store.resetTokens
      .filter((token) => token.userId === userId && !token.usedAt && token.expiresAt > now)
      .map((token) => token.createdAt.getTime());
    return open.length > 0 ? new Date(Math.max(...open)) : null;
  }

  async createResetToken(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    store.resetTokens.push({ id: randomUUID(), usedAt: null, createdAt: new Date(), ...data });
  }

  async findResetTokenByHash(tokenHash: string): Promise<ResetTokenRecord | null> {
    const token = store.resetTokens.find((candidate) => candidate.tokenHash === tokenHash);
    return token
      ? { id: token.id, userId: token.userId, expiresAt: token.expiresAt, usedAt: token.usedAt }
      : null;
  }

  async useResetToken(id: string, now: Date): Promise<boolean> {
    const token = store.resetTokens.find((candidate) => candidate.id === id);
    if (!token || token.usedAt) {
      return false;
    }
    token.usedAt = now;
    return true;
  }

  async useAllResetTokens(userId: string, now: Date): Promise<void> {
    for (const token of store.resetTokens) {
      if (token.userId === userId && !token.usedAt) {
        token.usedAt = now;
      }
    }
  }
}

// What the core middleware (auth, requirePermission) and the health module read through the global client.
export const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const user = store.users.find((candidate) => candidate.id === where.id);
      return user ? { id: user.id, role: user.role, isActive: user.isActive } : null;
    },
  },
  userPermission: {
    findFirst: async ({ where }: { where: { userId: string; permission: { code: string } } }) =>
      store.grants.some((grant) => grant.userId === where.userId && grant.code === where.permission.code)
        ? { userId: where.userId }
        : null,
    // The grants of one user, as the permissions repository reads them (the summary of a contractor cuts its sections by them).
    findMany: async ({ where }: { where: { userId: string } }) =>
      store.grants
        .filter((grant) => grant.userId === where.userId)
        .map((grant) => ({ permission: { code: grant.code } })),
  },
  $queryRaw: async () => [{ ok: 1 }],
  // Services that write their own audit entry (exports) open a transaction on the global client.
  $transaction: <T>(work: (tx: Db) => Promise<T>): Promise<T> =>
    new InMemoryAuthRepository().transaction(work),
};
