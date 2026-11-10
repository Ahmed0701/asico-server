import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import {
  connectionOf,
  findSlice19Problems,
  isSlice19Applied,
  type Query,
  type Slice19Problem,
} from "./check-slice19.js";

// One-off cleanup of the two rows that make the slice 19 migration stop on the asico database (found by `npm run check:slice19`):
//   - the manual open work "tutle" (work phase MEP, and no electrical phase is named MEP), and
//   - the daily report prepared by "Administrator1" (and no electrical engineer has that name).
//
//   npm run cleanup:slice19          DRY RUN (the default): says which database it is looking at and what it WOULD delete.
//                                    Runs in a read-only transaction that is rolled back, so it changes nothing.
//   npm run cleanup:slice19 -- --yes DELETES, inside one transaction, those two rows and nothing else.
//
// What it can never do:
//   - Delete anything but the two ids below: each delete is `WHERE id = <the id> AND <the conditions of the problem>`, so a row
//     that no longer matches what the check found (someone changed it) is left alone and reported.
//   - Run after the migration: it uses the OLD column names (title, phase, workDone, preparedBy, villaId), which the migration
//     drops, so it refuses when the migration is applied.
//   - Touch the audit log other than by adding to it: the log is append-only (a trigger), and each deletion adds one entry
//     (`open_work.delete` / `daily_report.delete`, no actor, the whole old row as `before`), as the API's own delete does.
//   - Leave a row behind that points at a deleted one: before it deletes, it asks the catalog for every foreign key that points
//     at the table and refuses if any row still points at the id. (None does today: an open work and a daily report have no
//     dependents. The audit entries name them by id text only, with no foreign key.)
//
// When it has deleted, it runs the same four checks as `check:slice19` and prints what is left (nothing, if these were the only rows).
// Exit code 0: done (or a dry run that found the rows); 1: a row was refused or the check still finds other rows; 2: bad call.

export const OPEN_WORK_ID = "4d288d32-537d-4d47-8bcf-233dd278105b";
export const REPORT_ID = "3c1dfab4-b006-4e10-a897-58d1c036ca0f";

type Target = {
  kind: "OPEN_WORK_PHASE" | "REPORT_ENGINEER";
  id: string;
  table: "WorkItem" | "DailyReport";
  auditAction: "open_work.delete" | "daily_report.delete";
  // Selects the row if, and only if, it is still the one the check found (and locks it when `lock` is added by the caller).
  match: string;
};

// `$1` is the id. The conditions repeat the problem: a manual item with work phase MEP and no electrical phase of that name; a
// report prepared by "Administrator1" and no electrical engineer of that name (same comparison as the migration and the check).
const norm = (column: string): string => `lower(btrim(${column}, E' \\t\\r\\n'))`;
const TARGETS: Target[] = [
  {
    kind: "OPEN_WORK_PHASE",
    id: OPEN_WORK_ID,
    table: "WorkItem",
    auditAction: "open_work.delete",
    match: `FROM "WorkItem" w WHERE w."id" = $1 AND w."source" = 'MANUAL' AND w."elecPhaseId" IS NULL AND w."phase"::text = 'MEP'
            AND NOT EXISTS (SELECT 1 FROM "ElecPhase" p WHERE ${norm('p."name"')} = ${norm('w."phase"::text')})`,
  },
  {
    kind: "REPORT_ENGINEER",
    id: REPORT_ID,
    table: "DailyReport",
    auditAction: "daily_report.delete",
    match: `FROM "DailyReport" w WHERE w."id" = $1 AND w."preparedBy" = 'Administrator1'
            AND NOT EXISTS (SELECT 1 FROM "ElectricalEngineer" e WHERE ${norm('e."name"')} = ${norm('w."preparedBy"')})`,
  },
];

export type Finding =
  | { id: string; table: Target["table"]; state: "DELETE"; row: Record<string, unknown> }
  | { id: string; table: Target["table"]; state: "GONE" }
  // The row exists but is not (or no longer) the problem the check found: it is left alone.
  | { id: string; table: Target["table"]; state: "CHANGED" }
  // Something still points at the row: it is left alone.
  | { id: string; table: Target["table"]; state: "REFERENCED"; by: string[] };

// Every row, in any table, that has a foreign key to the given row. Empty when nothing depends on it.
async function dependentsOf(query: Query, table: string, id: string): Promise<string[]> {
  const fks = await query(
    `SELECT c.conrelid::regclass::text AS "child", a.attname AS "column"
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = format('%I.%I', current_schema(), $1::text)::regclass AND array_length(c.conkey, 1) = 1`,
    [table],
  );
  const found: string[] = [];
  for (const fk of fks.rows) {
    const count = await query(
      `SELECT count(*)::int AS "n" FROM ${String(fk["child"])} WHERE "${String(fk["column"])}" = $1`,
      [id],
    );
    const n = Number(count.rows[0]?.["n"] ?? 0);
    if (n > 0)
      found.push(`${n} row${n === 1 ? "" : "s"} of ${String(fk["child"])} (${String(fk["column"])})`);
  }
  return found;
}

// What the cleanup would do with each of the two rows, from the database as it is now. `lock` adds FOR UPDATE to the row's select.
export async function inspect(query: Query, lock = false): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const target of TARGETS) {
    const exists = await query(`SELECT 1 FROM "${target.table}" WHERE "id" = $1`, [target.id]);
    if (exists.rows.length === 0) {
      findings.push({ id: target.id, table: target.table, state: "GONE" });
      continue;
    }
    const matching = await query(
      `SELECT to_jsonb(w) AS "row" ${target.match}${lock ? " FOR UPDATE OF w" : ""}`,
      [target.id],
    );
    if (matching.rows.length === 0) {
      findings.push({ id: target.id, table: target.table, state: "CHANGED" });
      continue;
    }
    const by = await dependentsOf(query, target.table, target.id);
    findings.push(
      by.length > 0
        ? { id: target.id, table: target.table, state: "REFERENCED", by }
        : {
            id: target.id,
            table: target.table,
            state: "DELETE",
            row: matching.rows[0]!["row"] as Record<string, unknown>,
          },
    );
  }
  return findings;
}

// The one line that says what a finding is, for a person.
function describe(finding: Finding): string {
  const what = finding.table === "WorkItem" ? "open work" : "daily report";
  switch (finding.state) {
    case "GONE":
      return `${what} ${finding.id}: not there any more, nothing to delete.`;
    case "CHANGED":
      return `${what} ${finding.id}: REFUSED, it is not the row the check found any more (phase, source or "prepared by" differ, or the phase/engineer now exists). Left alone.`;
    case "REFERENCED":
      return `${what} ${finding.id}: REFUSED, still referenced by ${finding.by.join(", ")}. Left alone.`;
    case "DELETE": {
      const row = finding.row;
      return finding.table === "WorkItem"
        ? `${what} ${finding.id}: delete "${String(row["title"])}" (work phase ${String(row["phase"])}, status ${String(row["status"])}, manual).`
        : `${what} ${finding.id}: delete the report of ${String(row["reportDate"]).slice(0, 10)}, prepared by "${String(row["preparedBy"])}".`;
    }
  }
}

// The problems the check finds that are NOT the two rows (what would be left after the cleanup).
const others = (problems: Slice19Problem[]): Slice19Problem[] =>
  problems.filter(
    (problem) => !(problem.rowId !== undefined && TARGETS.some((target) => target.id === problem.rowId)),
  );

export async function main(url: string, argv: string[]): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--yes");
  if (unknown.length > 0) {
    console.error(
      `Unknown argument: ${unknown.join(" ")}. The only flag is --yes (without it, nothing is changed).`,
    );
    return 2;
  }
  const yes = argv.includes("--yes");
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
    console.log(
      yes
        ? "DELETE mode (--yes): the two rows below are deleted in one transaction.\n"
        : "DRY RUN: nothing is changed. Add --yes to delete.\n",
    );

    await client.query(yes ? "BEGIN" : "BEGIN READ ONLY");
    let committed = false;
    try {
      const query: Query = (text, values) => client.query(text, values);
      if (await isSlice19Applied(query)) {
        console.log(
          "REFUSED: the slice 19 migration is already applied to this database (the old columns are gone). Nothing to do.",
        );
        return 1;
      }
      if (yes) await client.query("SET LOCAL lock_timeout = '5s'");

      const findings = await inspect(query, yes);
      findings.forEach((finding) => console.log(`- ${describe(finding)}`));
      const refused = findings.some(
        (finding) => finding.state === "CHANGED" || finding.state === "REFERENCED",
      );
      const toDelete = findings.filter(
        (finding): finding is Extract<Finding, { state: "DELETE" }> => finding.state === "DELETE",
      );

      if (yes) {
        for (const finding of toDelete) {
          const target = TARGETS.find((candidate) => candidate.id === finding.id)!;
          // The same conditions again in the DELETE itself, so it can only ever remove the row that was just described.
          const deleted = await client.query(
            `DELETE FROM "${target.table}" d USING (SELECT w."id" ${target.match}) m WHERE d."id" = m."id" RETURNING to_jsonb(d) AS "row"`,
            [target.id],
          );
          if (deleted.rowCount !== 1)
            throw new Error(
              `Expected to delete exactly one ${target.table} row, deleted ${deleted.rowCount}.`,
            );
          await client.query(
            `INSERT INTO "AuditLog" ("id","action","entity","entityId","before","userAgent")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, 'scripts/slice19-cleanup.ts')`,
            [target.auditAction, target.table, target.id, JSON.stringify(finding.row)],
          );
        }
      }

      // The same four checks as `npm run check:slice19`, in the same transaction: in DELETE mode they see the rows gone.
      const remaining = yes ? await findSlice19Problems(query) : others(await findSlice19Problems(query));
      if (yes) {
        await client.query("COMMIT");
        committed = true;
      }
      console.log(
        yes
          ? `\nDeleted ${toDelete.length} row${toDelete.length === 1 ? "" : "s"}; one audit entry added for each.`
          : `\nWould delete ${toDelete.length} row${toDelete.length === 1 ? "" : "s"}. Nothing was changed.`,
      );
      if (remaining.length === 0) {
        console.log(
          yes
            ? "Check after the delete: nothing would stop the slice 19 migration any more."
            : "After that, the check would find nothing else: nothing would stop the slice 19 migration.",
        );
      } else {
        console.log(
          `${yes ? "Check after the delete" : "After that, the check would still find"}: ${remaining.length} other row${remaining.length === 1 ? "" : "s"}:`,
        );
        remaining.forEach((problem, index) =>
          console.log(`${index + 1}. [${problem.kind}] ${problem.description}`),
        );
      }
      return refused || remaining.length > 0 ? 1 : 0;
    } finally {
      if (!committed) await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

// Run when started as a script, not when a test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The .env is read only here, never when a test imports this file (it would bring the mail settings into the test).
  config({ quiet: true });
  process.exitCode = await main(process.env["DATABASE_URL"] ?? "", process.argv.slice(2));
}
