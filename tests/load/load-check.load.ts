import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, parse as parsePath } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import ExcelJS from "exceljs";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../db/connection.js";
import { scratchHolder } from "../db/scratch-prisma.js";

// THE LOAD CHECK. Not part of the suite (its file does not end in .test.ts, so `npm test` never finds it):
//
//   npm run load:check
//
// It builds a scratch schema on the local PostgreSQL (every migration applied, 400 villas with 120 days of records each), runs the
// real Express app in this process against it with an ADMIN token, and measures what a person would wait for: p50 and p95 of
// every list, detail, options, search, the dashboard and a handful of writes; each export at (up to) its 10,000-row cap, as a
// spreadsheet and as a PDF, with the memory it takes and how long it blocks the event loop; and a 2,000-row import and dry run.
// Then it runs EXPLAIN (ANALYZE, BUFFERS) on the slowest queries and drops the schema, in a `finally`, whatever happened.
//
// SAFETY, in the order it is enforced:
//   1. The free space of the disk the database lives on is checked first; below LOAD_MIN_FREE_GB (5) nothing is created.
//   2. The schema is named load14b_<12 hex digits>. Its name is asserted before anything is created and again before it is
//      dropped, and it can never be "public" or contain "asico". Every statement goes to a connection (or to the ORM, whose
//      adapter is given the schema) whose search_path is that schema.
//   3. After the data is made, the ORM is asked what it sees (the villa count and current_schema()): if it is not the scratch
//      schema the run stops before it measures or writes anything.
//   4. The row count of every table of the asico schema is read (by a connection that is read-only) before and after, and the
//      run fails if any differs.
// Nothing here creates or resets a database.
//
// The numbers are indicative: one laptop, PostgreSQL on the same machine, the app in the same process as the client, a fresh
// schema (so warm caches), planner statistics from an ANALYZE right after the load.

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("../db/scratch-prisma.js")).scratchPrismaModule,
);

import { createApp } from "../../src/app.js";
import { env } from "../../src/core/config/env.js";
import { signAccessToken } from "../../src/core/security/jwt.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";

const RUN = process.env.ASICO_LOAD_CHECK === "1";
const number = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const VILLAS = number("LOAD_VILLAS", 400);
const DAYS = number("LOAD_DAYS", 120);
const CONTRACTORS = 40;
// A daily report belongs to a contractor, one per contractor and day, so the biggest table keeps the size it had (a report for
// every villa and every day) by going further back in time.
const REPORT_DAYS = Math.ceil((VILLAS * DAYS) / CONTRACTORS);
const AREAS = 20;
const PHASES = 8;
const SMALL_WORKS_PER_VILLA = 60;
const SITE_REPORTS_PER_VILLA = 25;
const OPEN_WORKS_PER_VILLA = 25;
const AUDIT_PER_DAY = number("LOAD_AUDIT_PER_DAY", 1250);
const READ_RUNS = number("LOAD_READ_RUNS", 30);
const WARMUP = 5;
const EXPORT_RUNS = number("LOAD_EXPORT_RUNS", 10);
const IMPORT_RUNS = number("LOAD_IMPORT_RUNS", 10);
const WRITE_RUNS = number("LOAD_WRITE_RUNS", 30);
const MIN_FREE_GB = number("LOAD_MIN_FREE_GB", 5);
const EXPORT_CAP = 10_000;
const IMPORT_ROWS = 2000;
const REPORT_FILE = process.env.LOAD_REPORT;

// The thresholds proposed in the plan (p95), in milliseconds unless the name says otherwise.
const LIMITS = {
  list: 300,
  search: 500,
  dashboard: 500,
  write: 200,
  xlsx: 15_000,
  pdf: 30_000,
  import: 10_000,
  dryRun: 5_000,
  rssGrowthMb: 300,
  loopLagMs: 200,
} as const;
type Category = "list" | "search" | "dashboard" | "write" | "xlsx" | "pdf" | "import" | "dryRun";

type Row = {
  name: string;
  category: Category;
  runs: number;
  p50: number;
  p95: number;
  max: number;
  limit: number;
  detail: string;
};

const MIGRATIONS = new URL("../../prisma/migrations/", import.meta.url);
const DAY_MS = 86_400_000;

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const round = (value: number): number => Math.round(value * 10) / 10;

// The data directory's drive, whatever the platform (a path that cannot be read falls back to the working drive).
function freeGigabytes(path: string): number {
  for (const candidate of [path, parsePath(path).root, process.cwd()]) {
    try {
      const stats = statfsSync(candidate);
      return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
    } catch {
      // try the next
    }
  }
  return 0;
}

describe.skipIf(!RUN)("the load check", () => {
  let admin: pg.Client;
  let readOnly: pg.Client;
  let schema = "";
  let prisma: PrismaClient;
  let server: http.Server;
  let base = "";
  let adminId = "";
  let villaId = "";
  let contractorId = "";
  let auditId = "";
  let phaseId = "";
  let engineerId = "";
  let villaNumbers: string[] = [];
  let contractorNames: string[] = [];
  const rows: Row[] = [];
  const explains: string[] = [];
  const notes: string[] = [];
  const captured: { sql: string; params: string }[] = [];
  let capturing = false;
  let publicBefore: Record<string, number> = {};
  const started = Date.now();

  const q = (text: string, values?: unknown[]) => admin.query(text, values);
  const log = (message: string): void => {
    console.log(`[load ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);
  };

  async function publicCounts(): Promise<Record<string, number>> {
    const tables = await readOnly.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_%' ORDER BY 1",
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const result = await readOnly.query<{ n: string }>(`SELECT count(*) AS n FROM public."${tablename}"`);
      counts[tablename] = Number(result.rows[0]?.n);
    }
    return counts;
  }

  const bearer = async (): Promise<string> =>
    `Bearer ${await signAccessToken({ id: adminId, role: "ADMIN" })}`;

  // ---- the data ----

  async function seed(): Promise<void> {
    const today = "(date_trunc('day', now() AT TIME ZONE 'UTC'))::date";
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt")
       SELECT gen_random_uuid()::text, 'Load Admin', 'load-admin@example.test', 'x', 'ADMIN', true, now()`,
    );
    adminId = (await q(`SELECT "id" FROM "User" LIMIT 1`)).rows[0].id as string;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt")
       SELECT gen_random_uuid()::text, 'Employee ' || g, 'employee' || g || '@example.test', 'x', 'EMPLOYEE', true, now()
       FROM generate_series(1, 20) g`,
    );
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt")
       SELECT gen_random_uuid()::text, 'Phase ' || g, g, now() FROM generate_series(1, ${PHASES}) g`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt")
       SELECT gen_random_uuid()::text, 'Area ' || g, 'City ' || (g % 4), now() FROM generate_series(1, ${AREAS}) g`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","email","updatedAt")
       SELECT gen_random_uuid()::text, 'Contractor ' || lpad(g::text, 2, '0'), '0100' || lpad(g::text, 7, '0'),
              'contractor' || g || '@example.test', now() FROM generate_series(1, ${CONTRACTORS}) g`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","email","updatedAt")
       SELECT gen_random_uuid()::text, 'Civil Engineer ' || g, '0101' || lpad(g::text, 7, '0'), 'civil' || g || '@example.test', now()
       FROM generate_series(1, 12) g`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","email","updatedAt")
       SELECT gen_random_uuid()::text, 'Electrical Engineer ' || g, '0102' || lpad(g::text, 7, '0'), 'elec' || g || '@example.test', now()
       FROM generate_series(1, 12) g`,
    );
    log("reference data inserted");

    // A villa: the contractor is one of the 40, the area one of the 20; (area, block, plot) is unique because the plot is the number.
    await q(
      `WITH a AS (SELECT "id", row_number() OVER (ORDER BY "name") rn FROM "Area"),
            c AS (SELECT "id", row_number() OVER (ORDER BY "name") rn FROM "Contractor"),
            e AS (SELECT "id", row_number() OVER (ORDER BY "name") rn FROM "CivilEngineer"),
            x AS (SELECT "id", row_number() OVER (ORDER BY "name") rn FROM "ElectricalEngineer")
       INSERT INTO "Villa" ("id","villaNumber","ownerName","areaId","block","plot","civilEngineerId","electricalEngineerId",
                            "contractorId","startDate","targetDate","budgetMinor","currency","createdById","updatedAt")
       SELECT gen_random_uuid()::text, 'V-' || lpad(g::text, 4, '0'), 'Owner ' || g || ' Mansour',
              a."id", 'B' || (g % 10), g::text, e."id", x."id", c."id",
              ${today} - 200, ${today} + 100 + (g % 60), (1000000 + g * 1000)::bigint, 'KWD', '${adminId}', now()
       FROM generate_series(1, ${VILLAS}) g
       JOIN a ON a.rn = (g % ${AREAS}) + 1 JOIN c ON c.rn = (g % ${CONTRACTORS}) + 1
       JOIN e ON e.rn = (g % 12) + 1 JOIN x ON x.rn = (g % 12) + 1`,
    );
    const villas = await q(
      `SELECT v."id", v."villaNumber", c."name" AS contractor FROM "Villa" v JOIN "Contractor" c ON c."id" = v."contractorId" ORDER BY v."villaNumber"`,
    );
    villaId = villas.rows[0].id as string;
    villaNumbers = villas.rows.map((row) => row.villaNumber as string);
    contractorNames = villas.rows.map((row) => row.contractor as string);
    contractorId = (await q(`SELECT "id" FROM "Contractor" ORDER BY "name" LIMIT 1`)).rows[0].id as string;
    phaseId = (await q(`SELECT "id" FROM "ElecPhase" ORDER BY "sortOrder" LIMIT 1`)).rows[0].id as string;
    engineerId = (await q(`SELECT "id" FROM "ElectricalEngineer" ORDER BY "name" LIMIT 1`)).rows[0]
      .id as string;

    // Progress: a row for every villa and every phase, from 0 to 100.
    await q(
      `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","completedAt","updatedAt")
       SELECT v."id", p."id", s.p, CASE WHEN s.p = 100 THEN now() END, now()
       FROM "Villa" v CROSS JOIN "ElecPhase" p
       CROSS JOIN LATERAL (SELECT ((hashtext(v."id" || p."id") & 2147483647) % 101) AS p) s`,
    );
    log("villas and progress inserted");

    await q(
      `WITH p AS (SELECT "id", row_number() OVER (ORDER BY "sortOrder") rn FROM "ElecPhase")
       INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","priority","progress","contractorId","startDate","endDate","source","updatedAt")
       SELECT gen_random_uuid()::text, v."id", p."id",
              s.status::"WorkStatus", (ARRAY['LOW','MEDIUM','HIGH'])[1 + (w % 3)]::"Priority", s.progress, v."contractorId",
              ${today} - 60 + w, ${today} - 20 + w * 2, 'MANUAL', now()
       FROM "Villa" v CROSS JOIN generate_series(1, ${OPEN_WORKS_PER_VILLA}) w
       JOIN p ON p.rn = (w % ${PHASES}) + 1
       CROSS JOIN LATERAL (SELECT CASE w % 4 WHEN 0 THEN 'NOT_STARTED' WHEN 1 THEN 'IN_PROGRESS' WHEN 2 THEN 'DELAYED' ELSE 'DONE' END AS status,
                                  CASE w % 4 WHEN 0 THEN 0 WHEN 1 THEN 40 WHEN 2 THEN 70 ELSE 100 END AS progress) s`,
    );
    log("open works inserted");

    await q(
      `WITH x AS (SELECT "id", row_number() OVER (ORDER BY "name") rn FROM "ElectricalEngineer")
       INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","notes","preparedByEngineerId","contractorId","createdById","updatedAt")
       SELECT gen_random_uuid()::text, ${today} - d, (ARRAY['HOT','SUNNY','WINDY','RAINY','DUSTY'])[1 + (d % 5)]::"Weather",
              10 + (d % 40), 'Day ' || d || ': the work done for ' || c."name" || ', slab, rebar, shuttering and cleaning of the area, '
              || 'repeated so that the text is about as long as a real report is.' || CASE WHEN d % 7 = 0 THEN ' Late delivery of cement' ELSE '' END,
              x."id", c."id", '${adminId}', now()
       FROM "Contractor" c CROSS JOIN generate_series(0, ${REPORT_DAYS - 1}) d JOIN x ON x.rn = (d % 12) + 1`,
    );
    log("daily reports inserted");

    await q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","notes","createdById","updatedAt")
       SELECT gen_random_uuid()::text, v."id", ${today} - d, v."contractorId", 5 + (d % 30),
              CASE WHEN d % 5 = 0 THEN 'Two shifts' END, '${adminId}', now()
       FROM "Villa" v CROSS JOIN generate_series(0, ${DAYS - 1}) d`,
    );
    log("daily labour inserted");

    await q(
      `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","status","createdById","updatedAt")
       SELECT gen_random_uuid()::text, v."id", v."contractorId", ${today} - 2 * k - 1, ${today} - 2 * k, 'Small work ' || k || ' on ' || v."villaNumber" || ': replaced a fitting',
              CASE WHEN k % 3 = 0 THEN 'PENDING' ELSE 'DONE' END::"SmallWorkStatus", '${adminId}', now()
       FROM "Villa" v CROSS JOIN generate_series(0, ${SMALL_WORKS_PER_VILLA - 1}) k`,
    );
    log("small works inserted");

    await q(
      `INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","recommendations","createdById","updatedAt")
       SELECT gen_random_uuid()::text, v."id", 'Visit ' || k || ' of ' || v."villaNumber", ${today} - 4 * k, 'Eng. Inspector',
              (ARRAY['INSPECTION','SAFETY','PROGRESS','QUALITY'])[1 + (k % 4)]::"SiteReportType", 1 + (k % 5),
              'The works were inspected on site and found in order, apart from the items noted for the next visit.',
              CASE WHEN k % 2 = 0 THEN 'Keep the area clean' END, '${adminId}', now()
       FROM "Villa" v CROSS JOIN generate_series(0, ${SITE_REPORTS_PER_VILLA - 1}) k`,
    );
    log("site reports inserted");

    // The audit log: AUDIT_PER_DAY entries a day for DAYS days, none today, each at a different second.
    await q(
      `INSERT INTO "AuditLog" ("id","actorId","action","entity","entityId","after","ip","userAgent","requestId","createdAt")
       SELECT gen_random_uuid()::text, '${adminId}',
              (ARRAY['villa.update','daily_report.create','open_work.update','auth.login','small_work.create','villa.progress'])[1 + (i % 6)],
              (ARRAY['Villa','DailyReport','WorkItem','User','DailySmallWork','Villa'])[1 + (i % 6)],
              CASE WHEN i % 6 IN (0, 5) THEN (SELECT "id" FROM "Villa" OFFSET (i % ${VILLAS}) LIMIT 1) END,
              '{"note":"load"}'::jsonb, '203.0.113.5', 'Mozilla/5.0', 'req-' || i,
              (${today} - d)::timestamp + make_interval(secs => s)
       FROM generate_series(1, ${DAYS}) d CROSS JOIN generate_series(0, ${AUDIT_PER_DAY - 1}) s
       CROSS JOIN LATERAL (SELECT (d * ${AUDIT_PER_DAY} + s) AS i) n`,
    );
    auditId = (await q(`SELECT "id" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 1`)).rows[0].id as string;
    log("audit log inserted");
    await q("ANALYZE");
    log("analyzed");
  }

  // ---- measuring ----

  async function measure(
    name: string,
    category: Category,
    fn: () => Promise<{ ok: boolean; detail?: string }>,
    runs = READ_RUNS,
    warmup = WARMUP,
    limit: number = LIMITS[category],
  ): Promise<Row> {
    for (let i = 0; i < warmup; i++) await fn();
    const times: number[] = [];
    let detail = "";
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      const result = await fn();
      times.push(performance.now() - start);
      expect(result.ok, `${name} answered an error`).toBe(true);
      detail = result.detail ?? detail;
    }
    times.sort((a, b) => a - b);
    const row: Row = {
      name,
      category,
      runs,
      p50: round(percentile(times, 50)),
      p95: round(percentile(times, 95)),
      max: round(times[times.length - 1] ?? 0),
      limit,
      detail,
    };
    rows.push(row);
    log(`${name}: p50 ${row.p50} ms, p95 ${row.p95} ms (limit ${limit}) ${detail}`);
    return row;
  }

  // The path each GET was measured with, by its name, for EXPLAIN.
  const paths = new Map<string, string>();
  const get = (path: string, category: Category, name = `GET ${path}`) => {
    paths.set(name, path);
    return measure(name, category, async () => {
      const res = await request(server)
        .get(`/api/v1${path}`)
        .set("Authorization", await bearer());
      const total = (res.body as { meta?: { total?: number } }).meta?.total;
      return {
        ok: res.status === 200,
        detail: total === undefined ? `${res.text.length} B` : `${total} rows`,
      };
    });
  };

  // An export is read as a stream and thrown away, so what is measured is the server and not this process holding the file.
  function download(path: string): Promise<{ status: number; bytes: number }> {
    return new Promise((resolve, reject) => {
      void bearer().then((authorization) => {
        const req = http.get(`${base}/api/v1${path}`, { headers: { authorization } }, (res) => {
          let bytes = 0;
          res.on("data", (chunk: Buffer) => (bytes += chunk.length));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes }));
          res.on("error", reject);
        });
        req.on("error", reject);
      }, reject);
    });
  }

  async function measureExport(name: string, path: string, format: "xlsx" | "pdf"): Promise<void> {
    const limit = LIMITS[format];
    const times: number[] = [];
    let growth = 0;
    let lag = 0;
    let size = 0;
    for (let i = 0; i < EXPORT_RUNS; i++) {
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      let peak = process.memoryUsage().rss;
      const before = peak;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
      histogram.enable();
      const start = performance.now();
      const result = await download(`${path}${path.includes("?") ? "&" : "?"}format=${format}`);
      times.push(performance.now() - start);
      histogram.disable();
      clearInterval(sampler);
      expect(result.status, `${name} ${format}`).toBe(200);
      size = result.bytes;
      growth = Math.max(growth, (peak - before) / 1024 / 1024);
      lag = Math.max(lag, histogram.max / 1e6);
    }
    times.sort((a, b) => a - b);
    const row: Row = {
      name: `${name} (${format})`,
      category: format,
      runs: EXPORT_RUNS,
      p50: round(percentile(times, 50)),
      p95: round(percentile(times, 95)),
      max: round(times[times.length - 1] ?? 0),
      limit,
      detail: `${(size / 1024 / 1024).toFixed(1)} MB, +${growth.toFixed(0)} MB RSS, loop lag max ${lag.toFixed(0)} ms`,
    };
    rows.push(row);
    if (growth > LIMITS.rssGrowthMb)
      notes.push(`${row.name}: RSS grew ${growth.toFixed(0)} MB (limit ${LIMITS.rssGrowthMb})`);
    if (lag > LIMITS.loopLagMs)
      notes.push(`${row.name}: the event loop was blocked ${lag.toFixed(0)} ms (limit ${LIMITS.loopLagMs})`);
    log(`${row.name}: p50 ${row.p50} ms, p95 ${row.p95} ms (limit ${limit}) ${row.detail}`);
  }

  async function workbookOf(headers: string[], data: (string | number)[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(headers);
    for (const row of data) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async function measureImport(
    name: string,
    path: string,
    dryRun: boolean,
    make: (run: number) => Promise<Buffer>,
  ): Promise<void> {
    const times: number[] = [];
    let detail = "";
    for (let run = 0; run < IMPORT_RUNS; run++) {
      const file = await make(run);
      const start = performance.now();
      const res = await request(server)
        .post(`/api/v1${path}/import${dryRun ? "?dryRun=true" : ""}`)
        .set("Authorization", await bearer())
        .set("Idempotency-Key", randomUUID())
        .attach("file", file, {
          filename: "load.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      times.push(performance.now() - start);
      expect(res.status, `${name}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(dryRun ? 200 : 201);
      detail = `${(res.body as { data?: { total?: number } }).data?.total ?? IMPORT_ROWS} rows, ${(file.length / 1024).toFixed(0)} KB file`;
    }
    times.sort((a, b) => a - b);
    const category: Category = dryRun ? "dryRun" : "import";
    const row: Row = {
      name: `${dryRun ? "dry run" : "import"} ${name}`,
      category,
      runs: IMPORT_RUNS,
      p50: round(percentile(times, 50)),
      p95: round(percentile(times, 95)),
      max: round(times[times.length - 1] ?? 0),
      limit: LIMITS[category],
      detail,
    };
    rows.push(row);
    log(`${row.name}: p50 ${row.p50} ms, p95 ${row.p95} ms (limit ${row.limit}) ${detail}`);
  }

  // ---- EXPLAIN ----

  async function explain(endpoint: string): Promise<void> {
    captured.length = 0;
    capturing = true;
    await request(server)
      .get(`/api/v1${endpoint}`)
      .set("Authorization", await bearer());
    capturing = false;
    const queries = captured.filter((query) => /^\s*(SELECT|WITH)/i.test(query.sql)).slice();
    const out: string[] = [`### EXPLAIN (ANALYZE, BUFFERS) for GET ${endpoint}: ${queries.length} queries`];
    const plans: { ms: number; text: string }[] = [];
    for (const query of queries) {
      const params = ((): unknown[] => {
        try {
          return JSON.parse(query.params) as unknown[];
        } catch {
          return [];
        }
      })();
      try {
        const plan = await q(
          `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
          params.map((value) =>
            typeof value === "object" && value !== null ? JSON.stringify(value) : value,
          ),
        );
        const text = plan.rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n");
        const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? 0);
        plans.push({
          ms,
          text: `-- ${query.sql.replaceAll(`"${schema}".`, "").replace(/\s+/g, " ").slice(0, 600)}\n${text}`,
        });
      } catch (err) {
        plans.push({
          ms: 0,
          text: `-- ${query.sql.slice(0, 200)}\n(could not explain: ${(err as Error).message})`,
        });
      }
    }
    plans.sort((a, b) => b.ms - a.ms);
    // The three slowest queries in full; the rest by their time alone.
    out.push(...plans.slice(0, 3).map((plan) => plan.text));
    if (plans.length > 3)
      out.push(
        `(other queries, ms: ${plans
          .slice(3)
          .map((plan) => plan.ms)
          .join(", ")})`,
      );
    explains.push(out.join("\n\n"));
  }

  // ---- setup and teardown ----

  beforeAll(async () => {
    const url = new URL(databaseUrl());
    const probe = new pg.Client({ connectionString: url.toString() });
    await probe.connect();
    const directory =
      (await probe.query<{ data_directory: string }>("SHOW data_directory")).rows[0]?.data_directory ?? "";
    await probe.end();
    const free = freeGigabytes(directory);
    log(`free disk where PostgreSQL lives (${directory || "unknown"}): ${free.toFixed(1)} GB`);
    if (free < MIN_FREE_GB) {
      throw new Error(
        `not enough free disk to build the scratch schema (${free.toFixed(1)} GB, need ${MIN_FREE_GB})`,
      );
    }

    const readOnlyUrl = new URL(databaseUrl());
    readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    readOnly = new pg.Client({ connectionString: readOnlyUrl.toString() });
    await readOnly.connect();
    publicBefore = await publicCounts();

    schema = `load14b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    expect(schema).toMatch(/^load14b_[0-9a-f]{12}$/);
    expect(schema).not.toMatch(/asico|public/i);
    admin = new pg.Client({ connectionString: databaseUrl() });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path = ${schema}, public`);
    const names = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) await q(readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), "utf8"));
    log(`schema ${schema} created with ${names.length} migrations`);

    // The ORM, as the application builds it (the pool, the timeouts, Prisma's own transaction defaults), with the schema given to
    // the adapter and to the connections, and a listener for the queries that EXPLAIN will use.
    const adapter = new PrismaPg(
      {
        connectionString: databaseUrl(),
        max: env.DB_POOL_MAX,
        connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
        options: `-c search_path=${schema}`,
      },
      { schema },
    );
    prisma = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
    (
      prisma as unknown as {
        $on: (event: "query", handler: (e: { query: string; params: string }) => void) => void;
      }
    ).$on("query", (event) => {
      if (capturing) captured.push({ sql: event.query, params: event.params });
    });
    scratchHolder.client = prisma as unknown as Record<string | symbol, unknown>;

    await seed();

    // The ORM must be looking at the scratch schema, and only it.
    const seen = await prisma.$queryRaw<{ s: string }[]>`SELECT current_schema() AS s`;
    expect(seen[0]?.s).toBe(schema);
    expect(await prisma.villa.count()).toBe(VILLAS);
    expect(await prisma.user.count()).toBe(21);

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 3_600_000);

  afterAll(async () => {
    try {
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma?.$disconnect().catch(() => undefined);
      if (schema !== "") {
        // The name is checked again before anything is dropped.
        if (!/^load14b_[0-9a-f]{12}$/.test(schema)) throw new Error(`refusing to drop schema ${schema}`);
        const size = await admin.query<{ mb: string }>(
          `SELECT (sum(pg_total_relation_size(c.oid)) / 1024 / 1024)::int AS mb FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','m')`,
          [schema],
        );
        notes.push(`the scratch schema held ${size.rows[0]?.mb ?? "?"} MB of tables and indexes`);
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        const left = await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
        notes.push(left.rowCount === 0 ? `schema ${schema} dropped` : `SCHEMA ${schema} STILL EXISTS`);
      }
    } finally {
      await admin?.end().catch(() => undefined);
      if (readOnly) {
        const after = await publicCounts().catch(() => undefined);
        await readOnly.end().catch(() => undefined);
        if (after) {
          // A person using the app on this database while the check runs rotates their refresh token (a row added every 13
          // minutes), and that is not this run: its users are not in the asico schema, so a token of theirs could not be
          // stored there. Every other table must be exactly as it was.
          const changed = Object.keys(after).filter((table) => after[table] !== publicBefore[table]);
          const strange = changed.filter((table) => table !== "RefreshToken");
          if (strange.length > 0) {
            notes.push(`THE ASICO TABLES CHANGED: ${strange.join(", ")}`);
          } else if (changed.length > 0) {
            const grown = (after["RefreshToken"] ?? 0) - (publicBefore["RefreshToken"] ?? 0);
            notes.push(
              `the asico tables' row counts are unchanged, except RefreshToken ${grown >= 0 ? "+" : ""}${grown}: a live session of the app on this database rotating its token, not this run`,
            );
          } else {
            notes.push(`the asico tables' row counts are unchanged (${Object.keys(after).length} tables)`);
          }
          try {
            report();
          } finally {
            expect(strange).toEqual([]);
            expect((after["RefreshToken"] ?? 0) - (publicBefore["RefreshToken"] ?? 0)).toBeGreaterThanOrEqual(
              0,
            );
          }
        } else {
          report();
        }
      } else {
        report();
      }
    }
  }, 600_000);

  function report(): void {
    const lines: string[] = [];
    lines.push(`# Load check (${new Date().toISOString()})`, "");
    lines.push(
      `Dataset: ${VILLAS} villas x ${DAYS} days, ${CONTRACTORS} contractors, ${AREAS} areas, ${PHASES} phases. Node ${process.version}, ${env.DB_POOL_MAX} pooled connections.`,
      "",
    );
    lines.push(
      "| Measure | Runs | p50 ms | p95 ms | max ms | Limit (p95) | Result | Notes |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const row of rows) {
      lines.push(
        `| ${row.name} | ${row.runs} | ${row.p50} | ${row.p95} | ${row.max} | ${row.limit} | ${row.p95 <= row.limit ? "ok" : "OVER"} | ${row.detail} |`,
      );
    }
    lines.push("", ...notes.map((note) => `- ${note}`), "", ...explains);
    const text = lines.join("\n");
    console.log(text);
    if (REPORT_FILE) {
      mkdirSync(dirname(REPORT_FILE), { recursive: true });
      writeFileSync(REPORT_FILE, text);
    }
  }

  // ---- the measurements ----
  // In this order, and the order matters: the reads and the exports see the data as it was made (an export at exactly its cap), the
  // EXPLAINs are of those same reads, and only then do the writes and the imports add rows.

  it("the reads", async () => {
    await get("/villas?limit=20", "list", "GET /villas (page of 20)");
    await get("/villas?limit=20&sort=progress:desc", "list", "GET /villas sorted by progress");
    await get("/villas?limit=20&sort=location:asc", "list", "GET /villas sorted by location");
    await get(
      `/villas?limit=${Math.min(1000, VILLAS)}`,
      "list",
      `GET /villas (${Math.min(1000, VILLAS)} at once)`,
    );
    await get("/villas?limit=20&search=V-001", "search", "GET /villas?search=V-001 (number)");
    await get("/villas?limit=20&search=Mansour", "search", "GET /villas?search=Mansour (owner)");
    await get("/villas?limit=20&mewFollowUp=false&area=Area%203", "list", "GET /villas filtered by area");
    await get("/villas/filters", "list");
    await get("/villas/options", "list");
    await get(`/villas/${villaId}`, "list", "GET /villas/:id");
    await get("/dashboard/summary", "dashboard");
    await get("/dashboard/recent-activity", "list");
    for (const resource of [
      "areas",
      "contractors",
      "civil-engineers",
      "electrical-engineers",
      "elec-phases",
    ]) {
      await get(`/${resource}`, "list");
      await get(`/${resource}/options`, "list");
    }
    await get(`/contractors/${contractorId}/summary`, "list", "GET /contractors/:id/summary");
    await get("/contractors?search=Contractor%200", "search", "GET /contractors?search=Contractor 0");
    await get("/users", "list");
    await get("/permissions", "list");
    await get(`/villas/${villaId}/documents`, "list", "GET /villas/:id/documents");

    for (const resource of ["open-works", "daily-reports", "small-works", "site-reports", "daily-labour"]) {
      await get(`/${resource}?limit=20`, "list", `GET /${resource} (page of 20)`);
      await get(`/${resource}?limit=1000`, "list", `GET /${resource} (1000 at once)`);
      // A daily report has no villa: its owner is the contractor.
      if (resource === "daily-reports") {
        await get(
          `/${resource}?limit=20&contractorId=${contractorId}`,
          "list",
          `GET /${resource} of one contractor`,
        );
      } else {
        await get(`/${resource}?limit=20&villaId=${villaId}`, "list", `GET /${resource} of one villa`);
      }
    }
    await get("/open-works?limit=20&search=Open%20work%202", "search", "GET /open-works?search");
    await get("/open-works?limit=20&status=DELAYED&overdue=true", "list", "GET /open-works overdue");
    await get("/open-works?limit=20&sort=location:asc", "list", "GET /open-works sorted by location");
    // Four kinds of search on the biggest table: a word every row has, a word few rows have, a contractor name (a column of the
    // contractor, not of the report), and a word no row has (the case where nothing short-circuits).
    await get(
      "/daily-reports?limit=20&search=slab",
      "search",
      "GET /daily-reports?search (every row matches)",
    );
    await get("/daily-reports?limit=20&search=Day%2077%3A", "search", "GET /daily-reports?search (few rows)");
    await get(
      `/daily-reports?limit=20&search=${encodeURIComponent(contractorNames[17] ?? "Contractor 17")}`,
      "search",
      "GET /daily-reports?search (a contractor name)",
    );
    await get(
      "/daily-reports?limit=20&search=xyzzyplugh",
      "search",
      "GET /daily-reports?search (no row matches)",
    );
    await get("/daily-labour?limit=20&search=Two%20shifts", "search", "GET /daily-labour?search (notes)");
    await get(
      `/daily-labour?limit=20&search=${encodeURIComponent(contractorNames[3] ?? "Contractor 3")}`,
      "search",
      "GET /daily-labour?search (a contractor)",
    );
    await get(
      "/daily-reports?limit=20&sort=contractorName:asc",
      "list",
      "GET /daily-reports sorted by contractor",
    );
    await get("/small-works?limit=20&search=fitting", "search", "GET /small-works?search");
    await get("/site-reports?limit=20&search=Visit", "search", "GET /site-reports?search");

    await get("/audit-logs?limit=20", "list", "GET /audit-logs (page of 20)");
    await get(
      `/audit-logs?limit=20&entity=Villa&entityId=${villaId}`,
      "list",
      "GET /audit-logs of one villa",
    );
    await get("/audit-logs?limit=1000", "list", "GET /audit-logs (1000 at once)");
    await get("/audit-logs/filters", "list");
    await get(`/audit-logs/${auditId}`, "list", "GET /audit-logs/:id");
    expect(rows.length).toBeGreaterThan(40);
  }, 3_600_000);

  it("the exports", async () => {
    // Each window holds exactly EXPORT_CAP rows when the dataset is the full size; the rows are counted from the list.
    const perVilla = Math.max(1, Math.floor(EXPORT_CAP / VILLAS));
    // A report is one per contractor and day.
    const reportDays = Math.max(1, Math.floor(EXPORT_CAP / CONTRACTORS));
    const day = (offset: number) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
    const auditDays = Math.max(1, Math.min(DAYS, Math.ceil(EXPORT_CAP / AUDIT_PER_DAY)));
    const cases: [string, string, string][] = [
      ["daily reports", "/daily-reports/export", `reportFrom=${day(reportDays - 1)}&reportTo=${day(0)}`],
      ["daily labour", "/daily-labour/export", `labourFrom=${day(perVilla - 1)}&labourTo=${day(0)}`],
      ["small works", "/small-works/export", `endFrom=${day(perVilla * 2 - 1)}&endTo=${day(0)}`],
      ["site reports", "/site-reports/export", ""],
      ["open works", "/open-works/export", ""],
      ["audit log", "/audit-logs/export", `from=${day(auditDays)}&to=${day(1)}`],
      ["villas", "/villas/export", ""],
      ["contractors", "/contractors/export", ""],
      ["areas", "/areas/export", ""],
      ["civil engineers", "/civil-engineers/export", ""],
      ["electrical engineers", "/electrical-engineers/export", ""],
      ["contractor summary", `/contractors/${contractorId}/summary/export`, ""],
    ];
    for (const [name, path, query] of cases) {
      const listPath = path.replace("/export", "");
      const counted = await request(server)
        .get(`/api/v1${listPath}?limit=1${query ? `&${query}` : ""}`)
        .set("Authorization", await bearer());
      const total = (counted.body as { meta?: { total?: number } }).meta?.total;
      notes.push(`${name} export: ${total ?? "?"} rows`);
      for (const format of ["xlsx", "pdf"] as const) {
        await measureExport(name, `${path}${query ? `?${query}` : ""}`, format);
      }
    }
  }, 3_600_000);

  it("EXPLAIN on the slowest reads", async () => {
    // The slowest p95 reads, and any read over its limit.
    const reads = rows.filter((row) => row.name.startsWith("GET ")).sort((a, b) => b.p95 - a.p95);
    const over = reads.filter((row) => row.p95 > row.limit);
    const chosen = [...new Set([...over, ...reads.slice(0, 4)].map((row) => row.name))];
    notes.push(
      `reads over their limit: ${over.length === 0 ? "none" : over.map((row) => row.name).join("; ")}`,
    );
    for (const name of chosen) {
      const path = paths.get(name);
      if (path) await explain(path);
    }
    expect(chosen.length).toBeGreaterThan(0);
  }, 600_000);

  it("the writes", async () => {
    let day = REPORT_DAYS + 1;
    const headers = async (extra: Record<string, string> = {}) => ({
      Authorization: await bearer(),
      ...extra,
    });
    // The same contractor, a day nobody has used each time: create, update, delete.
    const created: { id: string; version: number }[] = [];
    await measure(
      "POST /daily-reports",
      "write",
      async () => {
        const res = await request(server)
          .post("/api/v1/daily-reports")
          .set(await headers({ "Idempotency-Key": randomUUID() }))
          .send({
            contractorId,
            preparedByEngineerId: engineerId,
            reportDate: new Date(Date.now() - day++ * DAY_MS).toISOString().slice(0, 10),
            weather: "SUNNY",
            workersCount: 12,
            notes: "Poured the slab",
          });
        if (res.status === 201)
          created.push({ id: (res.body as { data: { id: string } }).data.id, version: 1 });
        return { ok: res.status === 201 };
      },
      WRITE_RUNS,
      2,
    );
    let at = 0;
    await measure(
      "PATCH /daily-reports/:id",
      "write",
      async () => {
        const target = created[at++ % created.length]!;
        const res = await request(server)
          .patch(`/api/v1/daily-reports/${target.id}`)
          .set(await headers({ "If-Match": `"${target.version}"` }))
          .send({ workersCount: 20 + at });
        if (res.status === 200) target.version += 1;
        return { ok: res.status === 200 };
      },
      WRITE_RUNS,
      2,
    );
    let level = 1;
    await measure(
      "PATCH /villas/:id/phases/:id (progress)",
      "write",
      async () => {
        const res = await request(server)
          .patch(`/api/v1/villas/${villaId}/phases/${phaseId}`)
          .set(await headers())
          .send({ progress: (level += 3) % 100 });
        return { ok: res.status === 200 };
      },
      WRITE_RUNS,
      2,
    );
    await measure(
      "POST /open-works",
      "write",
      async () => {
        const res = await request(server)
          .post("/api/v1/open-works")
          .set(await headers({ "Idempotency-Key": randomUUID() }))
          .send({ villaId, elecPhaseId: phaseId, priority: "HIGH" });
        return {
          ok: res.status === 201,
          detail: res.status === 201 ? "" : JSON.stringify(res.body).slice(0, 200),
        };
      },
      WRITE_RUNS,
      2,
    );
    let deleting = 0;
    await measure(
      "DELETE /daily-reports/:id",
      "write",
      async () => {
        const target = created[deleting++]!;
        const res = await request(server)
          .delete(`/api/v1/daily-reports/${target.id}`)
          .set(await headers());
        return { ok: res.status === 204 || res.status === 200 };
      },
      Math.min(WRITE_RUNS, created.length - 2),
      2,
    );
  }, 3_600_000);

  it("the imports", async () => {
    const perRun = Math.max(1, Math.floor(IMPORT_ROWS / VILLAS));
    const sheetDays = (run: number, from: number) =>
      Array.from({ length: perRun }, (_, i) => from + run * perRun + i);
    const dayOf = (offset: number) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
    const forVillas = (count: number) => villaNumbers.slice(0, count);

    // A report is one per contractor and day: a file holds IMPORT_ROWS / CONTRACTORS days of every contractor.
    const contractorList = [...new Set(contractorNames)];
    const reportRun = Math.max(1, Math.floor(IMPORT_ROWS / contractorList.length));
    const reports = (from: number) => async (run: number) =>
      workbookOf(
        ["Report Date", "Contractor", "Electrical Engineer", "Weather", "Workers", "Notes"],
        Array.from({ length: reportRun }, (_, i) => from + run * reportRun + i).flatMap((offset) =>
          contractorList.map((contractor, index) => [
            dayOf(offset),
            contractor,
            `Electrical Engineer ${(index % 12) + 1}`,
            "Sunny",
            10 + (index % 20),
            `Imported day ${offset}: slab and rebar`,
          ]),
        ),
      );
    const labour = (from: number) => async (run: number) =>
      workbookOf(
        ["Villa Number", "Labour Date", "Labour Count", "Contractor", "Notes"],
        sheetDays(run, from).flatMap((offset) =>
          forVillas(VILLAS).map((villa, index) => [
            villa,
            dayOf(offset),
            5 + (index % 20),
            contractorNames[index] ?? "",
            "Imported",
          ]),
        ),
      );
    const works = (salt: string) => async (run: number) =>
      workbookOf(
        [
          "Villa Number",
          "Electrical Phase",
          "Status",
          "Priority",
          "Progress",
          "Contractor",
          "Start Date",
          "End Date",
        ],
        // An open work has no natural key, so a file differs from the one before it by its start date (a repeated file is refused).
        Array.from({ length: IMPORT_ROWS }, (_, i) => [
          villaNumbers[i % VILLAS] ?? "",
          `Phase ${(i % PHASES) + 1}`,
          "In progress",
          "Medium",
          40,
          contractorNames[i % VILLAS] ?? "",
          dayOf(30 + run + (salt === "dry" ? 0 : 500)),
          dayOf(-30),
        ]),
      );
    const contractors = (salt: string) => async (run: number) =>
      workbookOf(
        ["Name", "Phone", "Email", "Status"],
        Array.from({ length: IMPORT_ROWS }, (_, i) => [
          `Imported ${salt} contractor ${run}-${i}`,
          `0111${String(run * IMPORT_ROWS + i).padStart(7, "0")}`,
          "",
          "Active",
        ]),
      );

    // The villas of a file are new ones: numbers (as number cells, the way the client's sheet has them), plots and blocks that
    // nobody used. The area, the engineers and the contractor are found by name, as in a real file.
    let villaSerial = 0;
    const newVillas = (rows: number) => async () => {
      const first = villaSerial;
      villaSerial += rows;
      return workbookOf(
        [
          "Villa Number",
          "Owner Name",
          "Area",
          "Block",
          "Plot",
          "Contractor",
          "Electrical Engineer",
          "Civil Engineer",
          "Start Date",
          "Target Date",
          "Budget",
        ],
        Array.from({ length: rows }, (_, i) => {
          const n = first + i;
          return [
            1_000_000 + n,
            `Owner ${n} Mansour`,
            `Area ${(n % AREAS) + 1}`,
            `L${Math.floor(n / 500)}`,
            n,
            contractorNames[n % VILLAS] ?? "",
            `Electrical Engineer ${(n % 12) + 1}`,
            `Civil Engineer ${(n % 12) + 1}`,
            dayOf(30),
            dayOf(-120),
            1_000_000 + n * 10,
          ];
        }),
      );
    };

    // Each run is a file nobody sent before (new days, new names), so nothing is refused as a repeat.
    await measureImport("daily reports", "/daily-reports", true, reports(REPORT_DAYS + 1000));
    await measureImport("daily reports", "/daily-reports", false, reports(REPORT_DAYS + 100));
    await measureImport("daily labour", "/daily-labour", true, labour(DAYS + 400));
    await measureImport("daily labour", "/daily-labour", false, labour(DAYS + 10));
    await measureImport("open works", "/open-works", true, works("dry"));
    await measureImport("open works", "/open-works", false, works("real"));
    await measureImport("contractors", "/contractors", true, contractors("dry"));
    await measureImport("contractors", "/contractors", false, contractors("real"));
    await measureImport("villas, 400 rows", "/villas", true, newVillas(400));
    await measureImport("villas, 400 rows", "/villas", false, newVillas(400));
    await measureImport("villas, 2,000 rows", "/villas", true, newVillas(IMPORT_ROWS));
    await measureImport("villas, 2,000 rows", "/villas", false, newVillas(IMPORT_ROWS));
  }, 3_600_000);

  it("what is over its limit", () => {
    const over = rows.filter((row) => row.p95 > row.limit);
    notes.push(
      over.length === 0
        ? "every measure is within its limit"
        : `OVER: ${over.map((row) => row.name).join("; ")}`,
    );
    // The run reports what it finds; whether a limit is missed is for the report to say, not a failure of the script.
    expect(rows.length).toBeGreaterThan(0);
  });
});
