import cluster, { type Worker } from "node:cluster";
import os from "node:os";
import { env } from "./core/config/env.js";
import { logger } from "./core/config/logger.js";

// The production entry point. With WEB_CONCURRENCY 1 (the default) it is the plain server. Above 1 it forks that many server
// processes (0: one per CPU core), which share the port: the operating system hands each new connection to one of them, so
// requests are served on several cores at once. A worker that dies is replaced; a storm of deaths stops the whole thing so the
// container restarts it. On SIGTERM every worker finishes its open requests (SHUTDOWN_TIMEOUT_MS), then the primary exits.
//
// Shared state across workers: everything that must agree lives in PostgreSQL (data, idempotency keys, import batches, the
// security rate limits, the job lock). Only the general request limit and in-process caches are per worker.

const workerCount = env.WEB_CONCURRENCY === 0 ? os.availableParallelism() : env.WEB_CONCURRENCY;

// A worker that dies is restarted; this many deaths within RESTART_WINDOW_MS means something is wrong with every start.
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

if (workerCount <= 1 || !cluster.isPrimary) {
  await import("./server.js");
} else {
  // Every worker has its own pool: together they must stay under PostgreSQL max_connections (100 by default).
  const connections = workerCount * env.DB_POOL_MAX;
  if (connections > 90) {
    logger.warn(
      { workers: workerCount, poolMax: env.DB_POOL_MAX, connections },
      "the workers' database pools add up to more than 90 connections: lower DB_POOL_MAX or WEB_CONCURRENCY",
    );
  }

  let shuttingDown = false;
  const deaths: number[] = [];
  const indexOf = new Map<number, number>();

  const fork = (index: number): Worker => {
    const worker = cluster.fork({
      ASICO_CLUSTER_WORKERS: String(workerCount),
      ASICO_WORKER_INDEX: String(index),
    });
    indexOf.set(worker.id, index);
    return worker;
  };

  for (let index = 0; index < workerCount; index++) fork(index);
  logger.info({ workers: workerCount, port: env.PORT }, "cluster started");

  cluster.on("exit", (worker, code, signal) => {
    const index = indexOf.get(worker.id) ?? 0;
    indexOf.delete(worker.id);
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    const now = Date.now();
    deaths.push(now);
    while (deaths.length > 0 && now - deaths[0]! > RESTART_WINDOW_MS) deaths.shift();
    if (deaths.length > MAX_RESTARTS) {
      logger.fatal({ deaths: deaths.length }, "workers keep dying: stopping the cluster");
      process.exit(1);
    }
    logger.error({ worker: index, code, signal }, "worker died, starting another");
    setTimeout(() => fork(index), 1_000).unref();
  });

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "cluster shutting down");
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill("SIGTERM");
    // The workers time themselves out after SHUTDOWN_TIMEOUT_MS; this is the backstop.
    setTimeout(() => {
      logger.error("cluster shutdown timed out, forcing exit");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS + 5_000).unref();
    if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
