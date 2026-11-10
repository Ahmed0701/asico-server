import { logger } from "../../../core/config/logger.js";
import { prisma } from "../../../core/database/prisma.js";

export class HealthRepository {
  async ping(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      logger.warn({ err }, "database ping failed");
      return false;
    }
  }
}
