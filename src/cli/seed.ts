// The permissions catalog and the first administrator (ADMIN_EMAIL, ADMIN_PASSWORD). Safe to run again: it creates only what
// is missing. Production: node dist/cli/seed.js (no tsx). Development: npx prisma db seed (runs prisma/seed.ts, which runs this).
import { logger } from "../core/config/logger.js";
import { prisma } from "../core/database/prisma.js";
import { ensureAdmin } from "../core/seed/admin.js";
import { seedPermissions } from "../core/seed/permissions.js";

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
