import type { User } from "../../../src/generated/prisma/client.js";
import type { UserFilters, UserSort } from "../../../src/modules/users/dto/users.dto.js";
import type { Db, UsersRepository } from "../../../src/modules/users/repository/users.repository.js";
import { InMemoryAuthRepository, store, transactionLock } from "../auth/in-memory-auth.repository.js";

const authFake = new InMemoryAuthRepository();

// The auth fake rolls back users, tokens and audit rows; permission grants are rolled back here as well.
export async function inMemoryTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  const grants = structuredClone(store.grants);
  try {
    return await authFake.rawTransaction(work);
  } catch (err) {
    store.grants = grants;
    throw err;
  }
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function matches(user: User, { role, isActive, search }: UserFilters): boolean {
  const needle = search?.toLowerCase();
  return (
    (role === undefined || user.role === role) &&
    (isActive === undefined || user.isActive === isActive) &&
    (!needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle))
  );
}

function compare(a: User, b: User, { field, direction }: UserSort): number {
  const left = a[field];
  const right = b[field];
  const order = left < right ? -1 : left > right ? 1 : 0;
  return (direction === "asc" ? order : -order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class InMemoryUsersRepository implements UsersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => inMemoryTransaction(work));
  }

  async lockVersion(id: string): Promise<number | null> {
    return store.users.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async list(params: { filters: UserFilters; sort: UserSort; skip: number; take: number }) {
    const all = store.users
      .filter((user) => matches(user, params.filters))
      .sort((a, b) => compare(a, b, params.sort));
    return {
      users: all.slice(params.skip, params.skip + params.take).map((user) => ({ ...user })),
      total: all.length,
    };
  }

  async findById(id: string): Promise<User | null> {
    const user = store.users.find((candidate) => candidate.id === id);
    return user ? { ...user } : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const user = store.users.find((candidate) => candidate.email === email);
    return user ? { ...user } : null;
  }

  async createUser(data: {
    name: string;
    email: string;
    passwordHash: string;
    isActive: boolean;
  }): Promise<User> {
    if (store.users.some((user) => user.email === data.email)) {
      throw uniqueViolation();
    }
    return { ...store.addUser({ ...data, role: "EMPLOYEE" }) };
  }

  async updateUser(
    id: string,
    version: number,
    data: { name?: string; email?: string },
  ): Promise<User | null> {
    const user = store.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error("not found");
    }
    if (user.version !== version) {
      return null;
    }
    if (
      data.email !== undefined &&
      store.users.some((other) => other.id !== id && other.email === data.email)
    ) {
      throw uniqueViolation();
    }
    Object.assign(user, data, { updatedAt: new Date(), version: user.version + 1 });
    return { ...user };
  }

  async setActive(id: string, version: number, isActive: boolean): Promise<User | null> {
    const user = store.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error("not found");
    }
    if (user.version !== version) {
      return null;
    }
    user.isActive = isActive;
    user.version += 1;
    return { ...user };
  }

  async countAuthoredRecords(id: string): Promise<number> {
    // Imported here, not at the top: the villas fake imports from this file.
    const { villaTables } = await import("../villas/in-memory-villas.repository.js");
    return (
      villaTables.villas.filter((villa) => villa.createdById === id).length +
      villaTables.documents.filter((document) => document.uploadedById === id).length
    );
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = store.users.findIndex((candidate) => candidate.id === id && candidate.version === version);
    if (at < 0) return false;
    store.users.splice(at, 1);
    store.grants = store.grants.filter((grant) => grant.userId !== id);
    return true;
  }

  async revokeUserRefreshTokens(userId: string, now: Date): Promise<void> {
    for (const token of store.refreshTokens) {
      if (token.userId === userId && !token.revokedAt) {
        token.revokedAt = now;
      }
    }
  }
}
