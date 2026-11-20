import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The rate limit counters shared by the server processes of a cluster, on a real PostgreSQL (scratch schema): each hit is
// counted once even when many arrive together (as from several workers), limiters do not share counters, and a new window
// starts once the old one has ended.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { PostgresRateLimitStore } from "../../src/core/middleware/rateLimitStore.js";

const options = (windowMs: number) => ({ windowMs }) as never;

describe.skipIf(!RUN)("the shared rate limit store on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  beforeAll(async () => {
    scratch = await openScratch("scratchratelimit", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
  });

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("counts each hit once, even fifty at the same moment, as several workers would send them", async () => {
    const store = new PostgresRateLimitStore("login", undefined, () => 1);
    store.init(options(60_000));
    const results = await Promise.all(Array.from({ length: 50 }, () => store.increment("ip:1.2.3.4")));
    expect(results.map((r) => r.totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect((await store.get("ip:1.2.3.4"))?.totalHits).toBe(50);
    // A second store for the same limiter (another worker) sees the same counter.
    const other = new PostgresRateLimitStore("login", undefined, () => 1);
    other.init(options(60_000));
    expect((await other.increment("ip:1.2.3.4")).totalHits).toBe(51);
  });

  it("keeps the limiters and the clients apart", async () => {
    const exportStore = new PostgresRateLimitStore("export", undefined, () => 1);
    exportStore.init(options(60_000));
    expect((await exportStore.increment("ip:1.2.3.4")).totalHits).toBe(1);
    expect((await exportStore.increment("user:u1")).totalHits).toBe(1);
  });

  it("starts a new window once the old one has ended, and takes a hit back or forgets a client", async () => {
    const store = new PostgresRateLimitStore("refresh", undefined, () => 1);
    store.init(options(150));
    await store.increment("ip:9");
    const second = await store.increment("ip:9");
    expect(second.totalHits).toBe(2);
    expect(second.resetTime!.getTime()).toBeGreaterThan(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await store.get("ip:9")).toBeUndefined();
    expect((await store.increment("ip:9")).totalHits).toBe(1);

    await store.increment("ip:9");
    await store.decrement("ip:9");
    expect((await store.get("ip:9"))?.totalHits).toBe(1);
    await store.resetKey("ip:9");
    expect(await store.get("ip:9")).toBeUndefined();
  });

  it("removes the counters whose window has ended, now and then", async () => {
    const store = new PostgresRateLimitStore("auth-cleanup", undefined, () => 0);
    store.init(options(50));
    await store.increment("ip:old");
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The random draw always cleans up here: the old counter goes, the new one stays.
    await store.increment("ip:new");
    const rows = await q(`SELECT "key" FROM "RateLimitHit" WHERE "key" LIKE 'auth-cleanup:%' ORDER BY "key"`);
    expect(rows.rows.map((row: { key: string }) => row.key)).toEqual(["auth-cleanup:ip:new"]);
  });
});
