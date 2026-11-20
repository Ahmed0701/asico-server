import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import { prisma } from "../database/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

// About one increment in this many also removes the counters whose window has ended, so the table stays small.
const CLEANUP_EVERY = 200;

/**
 * Rate limit counters in PostgreSQL, shared by every server process: with several workers (WEB_CONCURRENCY) a limit such as
 * ten logins per fifteen minutes stays ten in all, not ten per worker. One row per limiter and key; an increment is a single
 * atomic upsert that starts a new window once the old one has ended.
 */
export class PostgresRateLimitStore implements Store {
  // Counters are shared across processes, not kept in this one.
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(
    // Keeps the limiters apart: "auth", "export", ...
    name: string,
    private readonly db: Db = prisma,
    private readonly random: () => number = Math.random,
  ) {
    this.prefix = `${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const rows = await this.db.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitHit" ("key", "hits", "resetAt")
      VALUES (${this.prefix + key}, 1, now() + ${this.windowMs} * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "RateLimitHit"."resetAt" <= now() THEN 1 ELSE "RateLimitHit"."hits" + 1 END,
        "resetAt" = CASE WHEN "RateLimitHit"."resetAt" <= now() THEN EXCLUDED."resetAt" ELSE "RateLimitHit"."resetAt" END
      RETURNING "hits", "resetAt"`;
    if (this.random() * CLEANUP_EVERY < 1) {
      await this.db.$executeRaw`DELETE FROM "RateLimitHit" WHERE "resetAt" < now()`;
    }
    const row = rows[0]!;
    return { totalHits: Number(row.hits), resetTime: row.resetAt };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = await this.db.$queryRaw<{ hits: number; resetAt: Date }[]>`
      SELECT "hits", "resetAt" FROM "RateLimitHit" WHERE "key" = ${this.prefix + key} AND "resetAt" > now()`;
    const row = rows[0];
    return row ? { totalHits: Number(row.hits), resetTime: row.resetAt } : undefined;
  }

  async decrement(key: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "RateLimitHit" SET "hits" = GREATEST("hits" - 1, 0) WHERE "key" = ${this.prefix + key}`;
  }

  async resetKey(key: string): Promise<void> {
    await this.db.$executeRaw`DELETE FROM "RateLimitHit" WHERE "key" = ${this.prefix + key}`;
  }
}
