import { logger } from "../src/core/config/logger.js";
import { prisma } from "../src/core/database/prisma.js";
import { ensureAdmin } from "./seed/admin.js";
import { seedPermissions } from "./seed/permissions.js";

async function main(): Promise<void> {
  const permissions = await seedPermissions(prisma);
  logger.info({ permissions }, "permissions seeded");

  const admin = await ensureAdmin(prisma, process.env);
  logger.info({ admin }, "admin seed finished");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
