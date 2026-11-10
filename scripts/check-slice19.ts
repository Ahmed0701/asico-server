import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";

// Slice 19 pre-flight: READ ONLY. Lists every row the slice 19 migration (prisma/migrations/20261111090000_slice19_schema)
// would stop on, so the data can be fixed BEFORE the migration is run. It changes nothing: it runs inside a
// `BEGIN READ ONLY` transaction (PostgreSQL itself refuses any write) that is always rolled back, and it never runs the
// migration. The first thing it prints is the database it is looking at.
//
//   npm run check:slice19
//
// Exit code 0: the migration would not stop on anything (or it was already applied). 1: there is at least one row to fix.
// The four checks below are the same four the migration makes in its step 0 and use the same comparison (case-insensitive,
// surrounding spaces ignored); tests/db/slice19.migration.db.test.ts proves that the two agree.

export type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type Slice19Problem = {
  // Which of the four checks found it.
  kind: "OPEN_WORK_PHASE" | "REPORT_NO_CONTRACTOR" | "REPORT_COLLISION" | "REPORT_ENGINEER";
  // One line, naming the row the way a person finds it.
  description: string;
  // The id of the open work or daily report the problem is about (a collision is about several reports and has none).
  rowId?: string;
};

// The same expression the migration uses to compare names.
const norm = (column: string): string => `lower(btrim(${column}, E' \\t\\r\\n'))`;

async function columnExists(query: Query, table: string, column: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

// True once the migration has been applied (the old columns are gone): there is nothing left to check.
export async function isSlice19Applied(query: Query): Promise<boolean> {
  return (
    !(await columnExists(query, "DailyReport", "villaId")) &&
    !(await columnExists(query, "WorkItem", "phase"))
  );
}

export async function findSlice19Problems(query: Query): Promise<Slice19Problem[]> {
  const problems: Slice19Problem[] = [];

  // 1. Open works with no electrical phase whose old work phase matches exactly one electrical phase by name in none of them.
  const works = await query(
    `SELECT w."id", w."title", w."phase"::text AS "phase", w."source"::text AS "source", v."villaNumber",
            (SELECT count(*)::int FROM "ElecPhase" p WHERE ${norm('p."name"')} = ${norm('w."phase"::text')}) AS "matches"
     FROM "WorkItem" w JOIN "Villa" v ON v."id" = w."villaId"
     WHERE w."elecPhaseId" IS NULL
       AND (SELECT count(*) FROM "ElecPhase" p WHERE ${norm('p."name"')} = ${norm('w."phase"::text')}) <> 1
     ORDER BY v."villaNumber", w."title", w."id"`,
  );
  for (const row of works.rows) {
    const reason =
      row["matches"] === 0
        ? `no electrical phase is named "${String(row["phase"])}"`
        : `${String(row["matches"])} electrical phases are named "${String(row["phase"])}"`;
    problems.push({
      kind: "OPEN_WORK_PHASE",
      rowId: String(row["id"]),
      description: `Open work "${String(row["title"])}" (id ${String(row["id"])}) on villa ${String(row["villaNumber"])}, work phase ${String(row["phase"])}: ${reason}. Give it an electrical phase, delete it, or add an electrical phase with that name.`,
    });
  }

  // 2. Daily reports with no contractor of their own and none on their villa.
  const lost = await query(
    `SELECT d."id", d."reportDate"::text AS "reportDate", v."villaNumber"
     FROM "DailyReport" d JOIN "Villa" v ON v."id" = d."villaId"
     WHERE d."contractorId" IS NULL AND v."contractorId" IS NULL
     ORDER BY v."villaNumber", d."reportDate"`,
  );
  for (const row of lost.rows) {
    problems.push({
      kind: "REPORT_NO_CONTRACTOR",
      rowId: String(row["id"]),
      description: `Daily report of ${String(row["reportDate"])} (id ${String(row["id"])}) on villa ${String(row["villaNumber"])}: the report has no contractor and the villa has none either. Give the villa a contractor, or delete the report.`,
    });
  }

  // 3. (contractor, date) pairs that would hold more than one report.
  const collisions = await query(
    `SELECT c."name" AS "contractor", g."reportDate"::text AS "reportDate", g."villas"
     FROM (
       SELECT coalesce(d."contractorId", v."contractorId") AS "contractorId", d."reportDate",
              string_agg(v."villaNumber", ', ' ORDER BY v."villaNumber") AS "villas"
       FROM "DailyReport" d JOIN "Villa" v ON v."id" = d."villaId"
       WHERE coalesce(d."contractorId", v."contractorId") IS NOT NULL
       GROUP BY 1, 2
       HAVING count(*) > 1
     ) g JOIN "Contractor" c ON c."id" = g."contractorId"
     ORDER BY c."name", g."reportDate"`,
  );
  for (const row of collisions.rows) {
    problems.push({
      kind: "REPORT_COLLISION",
      description: `Contractor "${String(row["contractor"])}" has more than one daily report on ${String(row["reportDate"])} (villas ${String(row["villas"])}). Reports are never merged: delete or move the extra ones.`,
    });
  }

  // 4. Daily reports whose "prepared by" text matches exactly one electrical engineer by name in none of them.
  const engineers = await query(
    `SELECT d."id", d."preparedBy", d."reportDate"::text AS "reportDate", v."villaNumber",
            (SELECT count(*)::int FROM "ElectricalEngineer" e WHERE ${norm('e."name"')} = ${norm('d."preparedBy"')}) AS "matches"
     FROM "DailyReport" d JOIN "Villa" v ON v."id" = d."villaId"
     WHERE (SELECT count(*) FROM "ElectricalEngineer" e WHERE ${norm('e."name"')} = ${norm('d."preparedBy"')}) <> 1
     ORDER BY d."preparedBy", d."reportDate", v."villaNumber"`,
  );
  for (const row of engineers.rows) {
    const reason =
      row["matches"] === 0
        ? "no electrical engineer has that name"
        : `${String(row["matches"])} electrical engineers have that name`;
    problems.push({
      kind: "REPORT_ENGINEER",
      rowId: String(row["id"]),
      description: `Daily report of ${String(row["reportDate"])} (id ${String(row["id"])}) on villa ${String(row["villaNumber"])}, prepared by "${String(row["preparedBy"])}": ${reason}. Add the engineer, or change the report's text to an engineer's name.`,
    });
  }

  return problems;
}

// The connection string without the Prisma-only `schema` parameter (PostgreSQL does not know it), and that schema.
export function connectionOf(url: string): { connectionString: string; schema: string } {
  const parsed = new URL(url);
  const schema = parsed.searchParams.get("schema") ?? "public";
  parsed.searchParams.delete("schema");
  return { connectionString: parsed.toString(), schema };
}

export async function main(url: string): Promise<number> {
  if (url === "") {
    console.error("DATABASE_URL is not set (copy .env.example to .env).");
    return 2;
  }
  const { connectionString, schema } = connectionOf(url);
  const client = new pg.Client({ connectionString, options: `-c search_path=${schema},public` });
  await client.connect();
  try {
    // First of all, say where this is looking.
    const where = (
      await client.query(
        `SELECT current_database() AS "database", current_schema() AS "schema", current_user AS "user",
                coalesce(inet_server_addr()::text, 'local socket') AS "host", inet_server_port() AS "port"`,
      )
    ).rows[0] as { database: string; schema: string; user: string; host: string; port: number | null };
    console.log(
      `Database: ${where.database}  (schema ${where.schema}, user ${where.user}, server ${where.host}:${where.port ?? "-"})`,
    );
    console.log("Read only: nothing is written, and the migration is not run.\n");

    await client.query("BEGIN READ ONLY");
    try {
      const query: Query = (text, values) => client.query(text, values);
      if (await isSlice19Applied(query)) {
        console.log("Slice 19 is already applied to this database: nothing to check.");
        return 0;
      }
      const problems = await findSlice19Problems(query);
      if (problems.length === 0) {
        console.log("Nothing would stop the slice 19 migration: every row can be placed.");
        return 0;
      }
      console.log(
        `The slice 19 migration would stop on ${problems.length} row${problems.length === 1 ? "" : "s"}:\n`,
      );
      problems.forEach((problem, index) =>
        console.log(`${index + 1}. [${problem.kind}] ${problem.description}`),
      );
      console.log("\nFix them, run this again until it is clean, then run the migration.");
      return 1;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

// Run when started as a script, not when a test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The .env is read only here, never when a test imports this file (it would bring the mail settings into the test).
  config({ quiet: true });
  process.exitCode = await main(process.env["DATABASE_URL"] ?? "");
}
