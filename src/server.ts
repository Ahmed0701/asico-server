import { createApp } from "./app.js";
import { env } from "./core/config/env.js";
import { logger } from "./core/config/logger.js";
import { prisma } from "./core/database/prisma.js";
import { startSmallWorksAlertJob } from "./modules/notifications/index.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "server started");
});

// The hourly check of the small works (due soon and overdue notifications, and the admins' digest email). Several instances may
// each run it: the job takes a database lock, so only one of them works at a time.
const alertJob = env.SMALL_WORKS_ALERT_JOB_ENABLED ? startSmallWorksAlertJob() : undefined;

server.on("error", (err) => {
  logger.fatal({ err }, "server failed to start");
  process.exit(1);
});

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ reason }, "shutting down");

  setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();

  try {
    alertJob?.stop();
    await closeServer();
    await prisma.$disconnect();
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection");
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});
