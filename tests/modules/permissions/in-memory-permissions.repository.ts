import type { Role } from "../../../src/generated/prisma/client.js";
import type {
  Db,
  PermissionsRepository,
} from "../../../src/modules/permissions/repository/permissions.repository.js";
import { PERMISSION_CODES } from "../../../src/shared/constants/permissions.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

// The codes that exist in the Permission table. Tests remove one to simulate a seed that was not run.
export const permissionTable = {
  codes: [...PERMISSION_CODES] as string[],
  reset(): void {
    this.codes = [...PERMISSION_CODES];
  },
};

export class InMemoryPermissionsRepository implements PermissionsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => inMemoryTransaction(work));
  }

  async listCodes(): Promise<string[]> {
    return [...permissionTable.codes].sort();
  }

  async findUser(id: string): Promise<{ id: string; role: Role } | null> {
    const user = store.users.find((candidate) => candidate.id === id);
    return user ? { id: user.id, role: user.role } : null;
  }

  async getUserCodes(userId: string): Promise<string[]> {
    return store.grants
      .filter((grant) => grant.userId === userId)
      .map((grant) => grant.code)
      .sort();
  }

  async setUserCodes(
    userId: string,
    codes: readonly string[],
  ): Promise<{ before: string[]; after: string[] }> {
    const before = await this.getUserCodes(userId);
    const after = [...new Set(codes)].sort();
    const toAdd = after.filter((code) => !before.includes(code));
    const missing = toAdd.filter((code) => !permissionTable.codes.includes(code));
    if (missing.length > 0) {
      throw new Error(`Permission codes missing from the database (run the seed): ${missing.join(", ")}`);
    }
    store.grants = store.grants.filter((grant) => grant.userId !== userId || after.includes(grant.code));
    store.grant(userId, ...toAdd);
    return { before, after };
  }
}
