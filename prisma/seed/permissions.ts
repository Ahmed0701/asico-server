import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PERMISSION_CODES } from "../../src/shared/constants/permissions.js";

export async function seedPermissions(db: Pick<PrismaClient, "permission">): Promise<number> {
  for (const code of PERMISSION_CODES) {
    await db.permission.upsert({ where: { code }, update: {}, create: { code } });
  }
  return PERMISSION_CODES.length;
}
