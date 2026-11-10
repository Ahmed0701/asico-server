import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// These read the SQL text only. Whether Postgres enforces it needs a live database.
const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const sqlOf = (suffix: string): string => {
  const name = migrationNames.find((candidate) => candidate.endsWith(`_${suffix}`));
  if (!name) {
    throw new Error(`migration *_${suffix} not found`);
  }
  return readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8").replace(/\r\n/g, "\n");
};

const init = sqlOf("init");
const extras = sqlOf("extras");
const rotation = sqlOf("refresh_token_rotation");
const writeSafety = sqlOf("write_safety");
const electrical = sqlOf("electrical_engineers");
const elecPhases = sqlOf("elec_phases");
const partyEmailStatus = sqlOf("party_email_status");
const areas = sqlOf("areas");
const villas = sqlOf("villas");
const villaReshape = sqlOf("villa_reshape");
const villaProgress = sqlOf("villa_phase_progress");
const readyForInspection = sqlOf("ready_for_inspection");
const removeReadyForInspection = sqlOf("remove_ready_for_inspection");
const importBatch = sqlOf("import_batch");
const openWorks = sqlOf("open_works");
const reportSearchIndexes = sqlOf("daily_report_search_indexes");
// Line endings are read as \n: a Windows checkout (core.autocrlf) turns them into \r\n.
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("migration order", () => {
  it("applies init, then extras, then the later changes", () => {
    expect(migrationNames.map((name) => name.replace(/^\d+_/, ""))).toEqual([
      "init",
      "extras",
      "refresh_token_rotation",
      "write_safety",
      "electrical_engineers",
      "elec_phases",
      "party_email_status",
      "areas",
      "villas",
      "villa_reshape",
      "villa_phase_progress",
      "ready_for_inspection",
      "import_batch",
      "open_works",
      "daily_reports",
      "daily_small_works",
      "site_reports",
      "daily_labour",
      "daily_report_search_indexes",
      "small_works_contractor_dates",
      "notifications",
      "slice19_schema",
      "villa_type",
      "open_work_notifications",
      "mew_follow_up",
      "elec_phase_progress_ratio",
      "remove_automatic_open_works",
      "mew_states_and_inspection",
      "mew_inspection_passed",
      "mew_inspection_date",
      "remove_ready_for_inspection",
      "maintenance_villas",
      "material_deliveries",
      "material_items",
      "delivery_note_files",
      "material_required_default",
      "remove_fixed_materials",
      "users_delete_permission",
    ]);
  });

  it("keeps GIN indexes out of init, where pg_trgm does not exist yet", () => {
    expect(init).not.toMatch(/gin_trgm_ops|USING GIN/i);
  });
});

describe("extras migration: trigram search", () => {
  it("creates pg_trgm before the first trigram index", () => {
    const extension = extras.indexOf("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    const firstIndex = extras.indexOf("gin_trgm_ops");
    expect(extension).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeGreaterThan(extension);
  });

  it.each([
    ["Project_projectNumber_trgm_idx", "Project", "projectNumber", "Villa_villaNumber_trgm_idx"],
    ["Project_plotNumber_trgm_idx", "Project", "plotNumber", "Villa_plot_trgm_idx"],
    ["Project_block_trgm_idx", "Project", "block", "Villa_block_trgm_idx"],
    ["Contractor_name_trgm_idx", "Contractor", "name", "Contractor_name_trgm_idx"],
  ])(
    "creates GIN index %s, which the schema now declares as %s (the villas migration renames it)",
    (indexName, table, column, nowNamed) => {
      expect(extras).toContain(
        `CREATE INDEX "${indexName}" ON "${table}" USING GIN ("${column}" gin_trgm_ops);`,
      );
      expect(schema).toContain(`map: "${nowNamed}"`);
      if (nowNamed !== indexName) {
        expect(villas).toContain(`ALTER INDEX "${indexName}" RENAME TO "${nowNamed}";`);
        expect(schema).not.toContain(`map: "${indexName}"`);
      }
    },
  );
});

describe("extras migration: the project area index", () => {
  it("created Project_area_trgm_idx, which the areas migration later drops with the column", () => {
    expect(extras).toContain(
      'CREATE INDEX "Project_area_trgm_idx" ON "Project" USING GIN ("area" gin_trgm_ops);',
    );
    expect(schema).not.toContain("Project_area_trgm_idx");
  });
});

describe("extras migration: constraints", () => {
  it("allows only one ADMIN user through a partial unique index", () => {
    expect(extras).toContain(
      `CREATE UNIQUE INDEX "User_single_admin_idx" ON "User" ("role") WHERE "role" = 'ADMIN';`,
    );
  });

  it("restricts activity position to 1..4", () => {
    expect(extras).toMatch(
      /ADD CONSTRAINT "ProjectActivity_position_check" CHECK \("position" BETWEEN 1 AND 4\)/,
    );
  });
});

describe("extras migration: AuditLog is append-only", () => {
  const functionBody = /AS \$\$([\s\S]*?)\$\$;/.exec(extras)?.[1] ?? "";

  it("fires on UPDATE and DELETE per row, and on TRUNCATE per statement", () => {
    expect(extras).toMatch(/BEFORE UPDATE OR DELETE ON "AuditLog"\s+FOR EACH ROW/);
    expect(extras).toMatch(/BEFORE TRUNCATE ON "AuditLog"\s+FOR EACH STATEMENT/);
  });

  it("rejects everything by default", () => {
    const afterAllowBranch = functionBody.slice(functionBody.indexOf("END IF;"));
    expect(afterAllowBranch).toMatch(/RAISE EXCEPTION 'AuditLog is append-only: % rejected', TG_OP/);
  });

  it("allows an UPDATE only when actorId goes from a value to NULL and nothing else changes", () => {
    const allowBranch = functionBody.slice(functionBody.indexOf("IF"), functionBody.indexOf("END IF;"));
    expect(allowBranch).toContain("TG_OP = 'UPDATE'");
    expect(allowBranch).toContain(`OLD."actorId" IS NOT NULL`);
    expect(allowBranch).toContain(`NEW."actorId" IS NULL`);
    expect(allowBranch).toContain(`(to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId')`);
  });

  it("returns NEW exactly once, inside the allow branch, and never lets DELETE or TRUNCATE through", () => {
    expect(functionBody.match(/RETURN/g)).toHaveLength(1);
    expect(functionBody).toMatch(/RETURN NEW;\s+END IF;/);
    expect(functionBody).not.toMatch(/RETURN OLD|RETURN NULL/);
    expect(functionBody).not.toMatch(/TG_OP\s*=\s*'(DELETE|TRUNCATE)'/);
  });
});

describe("refresh token rotation migration", () => {
  it("only adds: one nullable column, a unique index and a foreign key, and drops or rewrites nothing", () => {
    expect(rotation).toContain(`ALTER TABLE "RefreshToken" ADD COLUMN     "replacedById" TEXT;`);
    expect(rotation).toContain(
      `CREATE UNIQUE INDEX "RefreshToken_replacedById_key" ON "RefreshToken"("replacedById");`,
    );
    expect(rotation).toMatch(
      /ADD CONSTRAINT "RefreshToken_replacedById_fkey" FOREIGN KEY \("replacedById"\) REFERENCES "RefreshToken"\("id"\) ON DELETE SET NULL/,
    );
    expect(rotation).not.toMatch(/^\s*(DROP|DELETE|UPDATE|TRUNCATE|ALTER TABLE .* DROP)\b|NOT NULL/im);
  });

  it("matches the schema", () => {
    expect(schema).toMatch(/replacedById\s+String\?\s+@unique/);
  });
});

describe("write safety migration", () => {
  it("adds a version, starting at 1, to the four tables people edit, and nothing else to them", () => {
    for (const table of ["CivilEngineer", "Contractor", "Project", "User"]) {
      expect(writeSafety).toContain(
        `ALTER TABLE "${table}" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;`,
      );
    }
    expect(writeSafety.match(/ALTER TABLE "(?:CivilEngineer|Contractor|Project|User)"/g)).toHaveLength(4);
  });

  it("creates IdempotencyKey with a unique (userId, key), an expiry index and a cascade from User", () => {
    expect(writeSafety).toContain(`CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');`);
    expect(writeSafety).toContain(
      'CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");',
    );
    expect(writeSafety).toContain(
      'CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");',
    );
    expect(writeSafety).toMatch(
      /"IdempotencyKey_userId_fkey" FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE/,
    );
  });

  it("stores no request: only a hash, and the response once there is one", () => {
    const table = /CREATE TABLE "IdempotencyKey" \(([\s\S]*?)\);/.exec(writeSafety)?.[1] ?? "";
    expect(table).toContain('"requestHash" TEXT NOT NULL');
    expect(table).toContain('"responseStatus" INTEGER,');
    expect(table).toContain('"responseBody" JSONB,');
    expect(table).not.toMatch(/"requestBody"|"body" /);
  });

  it("only adds: no drop, delete, update or truncate", () => {
    expect(writeSafety).not.toMatch(/^\s*(DROP|DELETE|UPDATE|TRUNCATE)\b/im);
    expect(writeSafety).not.toMatch(/ALTER TABLE .* DROP/i);
  });

  it("matches the schema", () => {
    // The write safety migration added the version to "Project"; the villas migration renamed that table.
    for (const model of ["User", "Villa", "Contractor", "CivilEngineer"]) {
      const pattern = new RegExp(String.raw`model ${model} \{[\s\S]*?\n\}`);
      expect(pattern.exec(schema)?.[0]).toMatch(/version\s+Int\s+@default\(1\)/);
    }
    expect(schema).toMatch(/@@unique\(\[userId, key\]\)/);
  });
});

describe("electrical engineers migration", () => {
  it("creates one table shaped like CivilEngineer, with a version starting at 1", () => {
    const table = /CREATE TABLE "ElectricalEngineer" \(([\s\S]*?)\n\);/.exec(electrical)?.[1] ?? "";
    expect(table).toContain('"id" TEXT NOT NULL');
    expect(table).toContain('"name" TEXT NOT NULL');
    expect(table).toContain('"phone" TEXT NOT NULL');
    expect(table).toContain('"version" INTEGER NOT NULL DEFAULT 1');
    expect(table).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(table).toContain('"updatedAt" TIMESTAMP(3) NOT NULL');
    expect(table).toContain('CONSTRAINT "ElectricalEngineer_pkey" PRIMARY KEY ("id")');
    expect(electrical.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it("adds the trigram index on the name that the search uses", () => {
    expect(electrical).toContain(
      'CREATE INDEX "ElectricalEngineer_name_trgm_idx" ON "ElectricalEngineer" USING GIN ("name" gin_trgm_ops);',
    );
  });

  it("only adds, and touches no existing table", () => {
    const statements = electrical
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
    expect(statements).not.toMatch(/"(User|Project|Contractor|CivilEngineer|AuditLog)"/);
  });

  it("matches the schema", () => {
    const model = /model ElectricalEngineer \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/version\s+Int\s+@default\(1\)/);
    expect(model).toContain('map: "ElectricalEngineer_name_trgm_idx"');
  });
});

describe("elec phases migration", () => {
  it("creates the status enum and one table with an order, a status that starts ACTIVE and a version", () => {
    expect(elecPhases).toContain(`CREATE TYPE "ElecPhaseStatus" AS ENUM ('ACTIVE', 'INACTIVE');`);
    const table = /CREATE TABLE "ElecPhase" \(([\s\S]*?)\n\);/.exec(elecPhases)?.[1] ?? "";
    expect(table).toContain('"id" TEXT NOT NULL');
    expect(table).toContain('"name" TEXT NOT NULL');
    expect(table).toContain('"sortOrder" INTEGER NOT NULL');
    expect(table).toContain(`"status" "ElecPhaseStatus" NOT NULL DEFAULT 'ACTIVE'`);
    expect(table).toContain('"version" INTEGER NOT NULL DEFAULT 1');
    expect(table).toContain('"updatedAt" TIMESTAMP(3) NOT NULL');
    expect(table).toContain('CONSTRAINT "ElecPhase_pkey" PRIMARY KEY ("id")');
    expect(elecPhases.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it("indexes the order and makes the name unique ignoring case", () => {
    expect(elecPhases).toContain('CREATE INDEX "ElecPhase_sortOrder_idx" ON "ElecPhase"("sortOrder");');
    expect(elecPhases).toContain(
      'CREATE UNIQUE INDEX "ElecPhase_name_lower_key" ON "ElecPhase" (lower("name"));',
    );
  });

  it("inserts exactly the six starting phases, in this order", () => {
    const values = /FROM \(VALUES([\s\S]*?)\) AS "phase"/.exec(elecPhases)?.[1] ?? "";
    const rows = [...values.matchAll(/\('([^']+)', (\d+)\)/g)].map((m) => [m[1], Number(m[2])]);
    expect(rows).toEqual([
      ["Ceiling Piping", 1],
      ["MSB Box Fixing", 2],
      ["Cut/out Box Fixing", 3],
      ["D.B Box Fixing", 4],
      ["Wall Piping", 5],
      ["Sleeves", 6],
    ]);
    expect(elecPhases.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("only adds, and touches no existing table", () => {
    const statements = elecPhases
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|ALTER)\b/i);
    expect(statements).not.toMatch(/"(User|Project|Contractor|CivilEngineer|ElectricalEngineer|AuditLog)"/);
  });

  it("matches the schema", () => {
    const model = /model ElecPhase \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/status\s+ElecPhaseStatus\s+@default\(ACTIVE\)/);
    expect(model).toMatch(/@@index\(\[sortOrder\]\)/);
    expect(schema).toMatch(/enum ElecPhaseStatus \{\s+ACTIVE\s+INACTIVE\s+\}/);
  });
});

describe("areas migration", () => {
  const statements = areas
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);

  it("creates the Area table with a name, a city and a version, and no stored count", () => {
    const table = /CREATE TABLE "Area" \(([\s\S]*?)\n\);/.exec(statements)?.[1] ?? "";
    expect(table).toContain('"name" TEXT NOT NULL');
    expect(table).toContain('"city" TEXT NOT NULL');
    expect(table).toContain('"version" INTEGER NOT NULL DEFAULT 1');
    expect(table).toContain('CONSTRAINT "Area_pkey" PRIMARY KEY ("id")');
    expect(table).not.toMatch(/count/i);
    expect(statements.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it("identifies an area by its name within its city, ignoring case", () => {
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "Area_name_city_lower_key" ON "Area" (lower("name"), lower("city"));',
    );
  });

  it("fills the areas from the project text before it makes the link required or drops the column", () => {
    const backfill = at('INSERT INTO "Area"');
    const add = at('ADD COLUMN "areaId" TEXT');
    const link = at('SET "areaId"');
    const required = at('ALTER COLUMN "areaId" SET NOT NULL');
    const drop = at('DROP COLUMN "area"');
    for (const position of [backfill, add, link, required, drop]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(backfill).toBeLessThan(link);
    expect(add).toBeLessThan(link);
    expect(link).toBeLessThan(required);
    expect(required).toBeLessThan(drop);
  });

  it("gives backfilled areas a placeholder city, one area per distinct value ignoring case and spaces", () => {
    expect(statements).toContain("'Unspecified'");
    expect(statements).toMatch(
      /INSERT INTO "Area"[\s\S]*?SELECT gen_random_uuid\(\)::text, "found"\."name", 'Unspecified', now\(\)/,
    );
    expect(statements).toMatch(/DISTINCT ON \(lower\(btrim\("area"\)\)\)/);
  });

  it("makes the link a restricting foreign key, so an area with villas cannot be deleted", () => {
    expect(statements).toContain(
      'ADD CONSTRAINT "Project_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
  });

  it("drops the old column's trigram index and unique key, and replaces them", () => {
    expect(statements).toContain('DROP INDEX "Project_area_trgm_idx";');
    expect(statements).toContain('DROP INDEX "Project_area_block_plotNumber_key";');
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "Project_areaId_block_plotNumber_key" ON "Project"("areaId", "block", "plotNumber");',
    );
    expect(statements).toContain('CREATE INDEX "Project_areaId_idx" ON "Project"("areaId");');
  });

  it("runs the way Prisma runs it, as one transaction, with nothing that would end it early", () => {
    expect(statements).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/i);
  });

  it("deletes nothing and touches no table but Area and Project", () => {
    expect(statements).not.toMatch(/\b(DELETE FROM|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/"(User|Contractor|CivilEngineer|ElectricalEngineer|ElecPhase|AuditLog)"/);
  });
});

describe("party email and status migration", () => {
  const tables = ["CivilEngineer", "ElectricalEngineer", "Contractor"];
  const statements = partyEmailStatus
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");

  it("creates the status enum once", () => {
    expect(statements).toContain(`CREATE TYPE "PartyStatus" AS ENUM ('ACTIVE', 'INACTIVE');`);
    expect(statements.match(/CREATE TYPE/g)).toHaveLength(1);
  });

  it.each(tables)("adds a nullable email and a status that starts ACTIVE to %s, in one ALTER", (table) => {
    const alter = new RegExp(`ALTER TABLE "${table}" ([^;]*);`).exec(statements)?.[1] ?? "";

    expect(alter).toContain('ADD COLUMN "email" TEXT');
    expect(alter).not.toMatch(/"email" TEXT\s+NOT NULL/);
    expect(alter).toContain(`ADD COLUMN "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE'`);
    expect(statements.match(new RegExp(`ALTER TABLE "${table}"`, "g"))).toHaveLength(1);
  });

  it("is purely additive: three ALTERs and one type, nothing dropped, rewritten or unique", () => {
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(3);
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT|RENAME)\b/i);
    expect(statements).not.toMatch(/UNIQUE|CREATE INDEX|CREATE TABLE/i);
    expect(statements).not.toMatch(/"(User|Project|ProjectContractor|AuditLog|ElecPhase)"/);
  });

  it("matches the schema", () => {
    for (const table of tables) {
      const model = new RegExp(String.raw`model ${table} \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";
      expect(model).toMatch(/email\s+String\?\n/);
      expect(model).not.toMatch(/email\s+String\?\s+@unique/);
      expect(model).toMatch(/status\s+PartyStatus\s+@default\(ACTIVE\)/);
    }
    expect(schema).toMatch(/enum PartyStatus \{\s+ACTIVE\s+INACTIVE\s+\}/);
  });
});

describe("villas migration", () => {
  const statements = villas
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);

  it("renames the two tables in place, so ids and the audit trail keep pointing at the same records", () => {
    expect(statements).toContain('ALTER TABLE "Project" RENAME TO "Villa";');
    expect(statements).toContain('ALTER TABLE "ProjectFile" RENAME TO "VillaDocument";');
    expect(statements).not.toMatch(/CREATE TABLE|DROP TABLE "Project"|DROP TABLE "ProjectFile"/);
  });

  it("renames the columns the way the villa platform names them", () => {
    for (const rename of [
      'RENAME COLUMN "projectNumber" TO "villaNumber"',
      'RENAME COLUMN "plotNumber" TO "plot"',
      'RENAME COLUMN "notifiedAt" TO "startDate"',
      'RENAME COLUMN "expectedReceiptDate" TO "targetDate"',
      'RENAME COLUMN "projectId" TO "villaId"',
    ]) {
      expect(statements).toContain(rename);
    }
  });

  it("drops the activities, the contractor link table, the status and flags, and the status enum", () => {
    expect(statements).toContain('DROP TABLE "ProjectActivity";');
    expect(statements).toContain('DROP TABLE "ProjectContractor";');
    expect(statements).toContain('ALTER TABLE "ProjectFile" DROP COLUMN "activityId";');
    expect(statements).toMatch(
      /ALTER TABLE "Project" DROP COLUMN "status",\s+DROP COLUMN "checklistCompleted",\s+DROP COLUMN "materialRequested";/,
    );
    expect(statements).toContain('DROP TYPE "ProjectStatus";');
  });

  it("deletes the test documents, and nothing else, before anything is dropped", () => {
    expect(statements.match(/DELETE FROM/g)).toHaveLength(2);
    expect(statements).toContain('DELETE FROM "ProjectFile";');
    expect(at('DELETE FROM "ProjectFile"')).toBeLessThan(at("DROP "));
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("copies each project's contractor onto the villa before the link table is dropped", () => {
    const add = at('ADD COLUMN "contractorId" TEXT');
    const copy = at('SET "contractorId" = (');
    const drop = at('DROP TABLE "ProjectContractor"');
    for (const position of [add, copy, drop]) expect(position).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(copy);
    expect(copy).toBeLessThan(drop);
    // A project with several links keeps the first one assigned, with the contractor id as the tie-break.
    expect(statements).toContain('ORDER BY pc."assignedAt" ASC, pc."contractorId" ASC');
    expect(statements).toContain("LIMIT 1");
  });

  it("makes the contractor a nullable column with a restricting foreign key and an index", () => {
    expect(statements).toContain('ALTER TABLE "Project" ADD COLUMN "contractorId" TEXT;');
    expect(statements).not.toMatch(/"contractorId" TEXT\s+NOT NULL/);
    expect(statements).toContain('CREATE INDEX "Villa_contractorId_idx" ON "Villa"("contractorId");');
    expect(statements).toContain(
      'ADD CONSTRAINT "Villa_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
  });

  it("renames every index, primary key and foreign key to the name Prisma expects, and leaves no Project name behind", () => {
    // Every name something is renamed TO.
    const renamed = [...statements.matchAll(/ TO "([^"]+)"/g)].map((match) => match[1]);
    for (const name of [
      "Villa_pkey",
      "VillaDocument_pkey",
      "Villa_villaNumber_key",
      "Villa_areaId_block_plot_key",
      "Villa_areaId_idx",
      "Villa_civilEngineerId_idx",
      "Villa_villaNumber_trgm_idx",
      "Villa_plot_trgm_idx",
      "Villa_block_trgm_idx",
      "VillaDocument_storageKey_key",
      "VillaDocument_villaId_idx",
      "Villa_areaId_fkey",
      "Villa_civilEngineerId_fkey",
      "Villa_createdById_fkey",
      "VillaDocument_villaId_fkey",
      "VillaDocument_uploadedById_fkey",
    ]) {
      expect(renamed).toContain(name);
    }
    for (const name of renamed) expect(name).not.toMatch(/Project/);
  });

  it("every index the schema names for a villa is created or renamed to by the migrations", () => {
    const later = villaReshape
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    for (const name of [...schema.matchAll(/map: "(Villa_[A-Za-z]+_trgm_idx)"/g)].map((match) => match[1])) {
      expect(statements + later).toMatch(new RegExp(`(TO|INDEX) "${name}"`));
    }
  });

  it("renames the permission rows in place, so existing grants keep working, and drops wall piping", () => {
    expect(statements).toContain(
      `UPDATE "Permission" SET "code" = 'villas:' || substr("code", 10) WHERE "code" LIKE 'projects:%';`,
    );
    expect(statements).toContain(
      `UPDATE "Permission" SET "code" = 'villa-documents:' || substr("code", 15) WHERE "code" LIKE 'project-files:%';`,
    );
    expect(statements).toContain(`DELETE FROM "Permission" WHERE "code" LIKE 'wall-piping:%';`);
    // 'projects:' is 9 characters and 'project-files:' is 14, so the suffix starts at 10 and 15.
    expect("projects:".length + 1).toBe(10);
    expect("project-files:".length + 1).toBe(15);
  });

  it("leaves the audit log and its trigger alone", () => {
    expect(statements).not.toMatch(/"AuditLog"/);
    expect(statements).not.toMatch(/\bTRIGGER\b/i);
  });

  it("runs the way Prisma runs it, as one transaction, with nothing that would end it early", () => {
    expect(statements).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b/i);
  });

  it("matches the schema", () => {
    const villa = /model Villa \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    const document = /model VillaDocument \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(villa).toMatch(/contractorId\s+String\?\n/);
    expect(villa).toMatch(/@@index\(\[contractorId\]\)/);
    expect(villa).toMatch(/startDate\s+DateTime\?/);
    expect(villa).toMatch(/targetDate\s+DateTime\?/);
    expect(document).toMatch(/villaId\s+String\n/);
    expect(schema).not.toMatch(/model Project|ProjectStatus/);
  });
});

describe("villa reshape migration", () => {
  const statements = villaReshape
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);
  const villa = /model Villa \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";

  it("checks for ICU and for bad date pairs first, and fails loudly with a reason", () => {
    expect(statements).toContain("collprovider = 'i'");
    expect(statements).toMatch(/RAISE EXCEPTION 'This PostgreSQL has no ICU collations/);
    expect(statements).toMatch(/RAISE EXCEPTION 'Some villas have a target date before their start date/);
    expect(at("RAISE EXCEPTION")).toBeLessThan(at("CREATE COLLATION"));
    expect(at("CREATE COLLATION")).toBeLessThan(at('ALTER TABLE "Villa"'));
  });

  it("creates the natural-order ICU collation", () => {
    expect(statements).toContain(
      "CREATE COLLATION \"asico_natural\" (provider = icu, locale = 'en-u-kn-true', deterministic = false);",
    );
  });

  it("turns the dates into DATE columns, taking the UTC day", () => {
    expect(statements).toContain('ALTER COLUMN "startDate" TYPE DATE USING ("startDate"::date)');
    expect(statements).toContain('ALTER COLUMN "targetDate" TYPE DATE USING ("targetDate"::date)');
    expect(villa).toMatch(/startDate\s+DateTime\?\s+@db\.Date/);
    expect(villa).toMatch(/targetDate\s+DateTime\?\s+@db\.Date/);
  });

  it("adds the four columns as nullable, with the types the schema declares", () => {
    expect(statements).toContain('ADD COLUMN "ownerName" TEXT,');
    expect(statements).toContain('ADD COLUMN "electricalEngineerId" TEXT,');
    expect(statements).toContain('ADD COLUMN "budgetMinor" BIGINT,');
    expect(statements).toContain('ADD COLUMN "currency" CHAR(3)');
    expect(statements).not.toMatch(/ADD COLUMN[^\n]*NOT NULL/);
    expect(statements).not.toMatch(/DEFAULT/);
    expect(villa).toMatch(/ownerName\s+String\?\n/);
    expect(villa).toMatch(/electricalEngineerId\s+String\?\n/);
    expect(villa).toMatch(/budgetMinor\s+BigInt\?\n/);
    expect(villa).toMatch(/currency\s+String\?\s+@db\.Char\(3\)/);
  });

  it("checks that the target date is not before the start date", () => {
    expect(statements).toContain(
      'CONSTRAINT "Villa_dates_check" CHECK ("startDate" IS NULL OR "targetDate" IS NULL OR "targetDate" >= "startDate")',
    );
  });

  it("checks the budget: both or neither, from 0 to 2^53 - 1, and a three-letter capital code", () => {
    expect(statements).toContain('CONSTRAINT "Villa_budget_check"');
    expect(statements).toContain('("budgetMinor" IS NULL) = ("currency" IS NULL)');
    expect(statements).toContain('"budgetMinor" >= 0 AND "budgetMinor" <= 9007199254740991');
    expect(statements).toContain("\"currency\" ~ '^[A-Z]{3}$'");
    expect(Number.MAX_SAFE_INTEGER).toBe(9007199254740991);
  });

  it("links the electrical engineer with a restricting foreign key and an index", () => {
    expect(statements).toContain(
      'CREATE INDEX "Villa_electricalEngineerId_idx" ON "Villa"("electricalEngineerId");',
    );
    expect(statements).toContain(
      'ADD CONSTRAINT "Villa_electricalEngineerId_fkey" FOREIGN KEY ("electricalEngineerId") REFERENCES "ElectricalEngineer"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(villa).toMatch(/electricalEngineer\s+ElectricalEngineer\?[^\n]*onDelete: Restrict/);
    expect(villa).toMatch(/@@index\(\[electricalEngineerId\]\)/);
  });

  it("adds trigram indexes for the owner and the civil engineer's name", () => {
    expect(statements).toContain(
      'CREATE INDEX "Villa_ownerName_trgm_idx" ON "Villa" USING GIN ("ownerName" gin_trgm_ops);',
    );
    expect(statements).toContain(
      'CREATE INDEX "CivilEngineer_name_trgm_idx" ON "CivilEngineer" USING GIN ("name" gin_trgm_ops);',
    );
  });

  it("deletes nothing and leaves the audit log and its trigger alone", () => {
    expect(statements).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/i);
    expect(statements).not.toMatch(/"AuditLog"/);
    expect(statements).not.toMatch(/\bTRIGGER\b/i);
  });

  it("runs the way Prisma runs it, as one transaction, with nothing that would end it early", () => {
    // The DO block has its own BEGIN ... END; a transaction control statement ends with a semicolon.
    expect(statements).not.toMatch(/\b(COMMIT|ROLLBACK)\b|^\s*BEGIN\s*;/im);
  });
});

describe("villa phase progress migration", () => {
  const statements = villaProgress
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);
  const model = new RegExp(String.raw`model VillaPhaseProgress \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("creates one table with a SMALLINT progress at 0, a version at 1, and the villa and phase as its key", () => {
    expect(statements).toContain('CREATE TABLE "VillaPhaseProgress"');
    expect(statements).toContain('"progress" SMALLINT NOT NULL DEFAULT 0,');
    expect(statements).toContain('"completedAt" TIMESTAMP(3),');
    expect(statements).toContain('"version" INTEGER NOT NULL DEFAULT 1,');
    expect(statements).toContain('PRIMARY KEY ("villaId","elecPhaseId")');
    expect(model).toMatch(/@@id\(\[villaId, elecPhaseId\]\)/);
  });

  it("deletes a villa's rows with it, and refuses to delete a phase that a row points at", () => {
    expect(statements).toContain(
      'ADD CONSTRAINT "VillaPhaseProgress_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'ADD CONSTRAINT "VillaPhaseProgress_elecPhaseId_fkey" FOREIGN KEY ("elecPhaseId") REFERENCES "ElecPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'CREATE INDEX "VillaPhaseProgress_elecPhaseId_idx" ON "VillaPhaseProgress"("elecPhaseId");',
    );
    expect(model).toMatch(/@@index\(\[elecPhaseId\]\)/);
  });

  it("checks the progress is from 0 to 100 and that it is completed exactly at 100", () => {
    expect(statements).toContain(
      'CONSTRAINT "VillaPhaseProgress_progress_check" CHECK ("progress" BETWEEN 0 AND 100)',
    );
    expect(statements).toContain(
      'CONSTRAINT "VillaPhaseProgress_completed_check" CHECK (("progress" = 100) = ("completedAt" IS NOT NULL))',
    );
  });

  it("backfills a row at 0 for every villa and phase, after the table and its rules exist", () => {
    expect(statements).toContain('FROM "Villa" v CROSS JOIN "ElecPhase" ph;');
    expect(statements).toMatch(/SELECT v\."id", ph\."id", 0, 1, now\(\)/);
    expect(at('CREATE TABLE "VillaPhaseProgress"')).toBeLessThan(at("progress_check"));
    expect(at("completed_check")).toBeLessThan(at('INSERT INTO "VillaPhaseProgress"'));
  });

  it("stores no overall progress on a villa and never touches the audit log", () => {
    expect(statements).not.toMatch(/ALTER TABLE "Villa"\s/);
    expect(statements).not.toContain("AuditLog");
    expect(statements).not.toMatch(/DROP |TRUNCATE|DELETE FROM/);
  });
});

describe("ready for inspection migration", () => {
  const statements = readyForInspection
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);
  const villaModel = new RegExp(String.raw`model Villa \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("adds exactly two nullable columns to Villa, a time and a user, with no default", () => {
    expect(statements).toContain(
      'ALTER TABLE "Villa" ADD COLUMN "readyForInspectionAt" TIMESTAMP(3),\nADD COLUMN "readyForInspectionById" TEXT;',
    );
    const columns = /ADD COLUMN[\s\S]*?;/.exec(statements)?.[0] ?? "";
    expect(columns).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("links the user with ON DELETE SET NULL, so the villa and its time outlive the user, and indexes the link", () => {
    expect(statements).toContain(
      'ADD CONSTRAINT "Villa_readyForInspectionById_fkey" FOREIGN KEY ("readyForInspectionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'CREATE INDEX "Villa_readyForInspectionById_idx" ON "Villa"("readyForInspectionById");',
    );
  });

  it("allows a user only together with a time", () => {
    expect(statements).toContain(
      'CONSTRAINT "Villa_ready_check" CHECK ("readyForInspectionById" IS NULL OR "readyForInspectionAt" IS NOT NULL)',
    );
    expect(at('ADD COLUMN "readyForInspectionAt"')).toBeLessThan(at("Villa_ready_check"));
  });

  it("marks no existing villa: it writes no data, derives nothing from the progress and never touches the audit log", () => {
    expect(statements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/m);
    expect(statements).not.toContain("VillaPhaseProgress");
    expect(statements).not.toContain("AuditLog");
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(3);
  });

  it("is undone by a later migration: the columns, their link, index and check are dropped, and the schema has none of them", () => {
    const later = removeReadyForInspection
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    expect(later).toContain('DROP CONSTRAINT IF EXISTS "Villa_ready_check"');
    expect(later).toContain('DROP CONSTRAINT IF EXISTS "Villa_readyForInspectionById_fkey"');
    expect(later).toContain('DROP INDEX IF EXISTS "Villa_readyForInspectionById_idx"');
    expect(later).toContain('DROP COLUMN "readyForInspectionAt"');
    expect(later).toContain('DROP COLUMN "readyForInspectionById"');
    expect(later).not.toContain("AuditLog");
    expect(villaModel).not.toMatch(/readyForInspection/);
  });
});

describe("import batch migration", () => {
  const statements = importBatch
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const model = new RegExp(String.raw`model ImportBatch \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("creates the ImportBatch table with an entity, a file hash, a nullable user and a row count", () => {
    const table =
      new RegExp(String.raw`CREATE TABLE "ImportBatch" \([\s\S]*?\n\);`).exec(statements)?.[0] ?? "";
    expect(table).toContain('"entity" TEXT NOT NULL');
    expect(table).toContain('"fileHash" TEXT NOT NULL');
    expect(table).toContain('"userId" TEXT,');
    expect(table).toContain('"rows" INTEGER NOT NULL');
    expect(table).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
  });

  it("makes (entity, fileHash) unique: the same file cannot be recorded twice, even by two imports at once", () => {
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "ImportBatch_entity_fileHash_key" ON "ImportBatch"("entity", "fileHash");',
    );
    expect(model).toMatch(/@@unique\(\[entity, fileHash\]\)/);
  });

  it("indexes the user, so a user's imports are found without reading the table", () => {
    expect(statements).toContain('CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");');
    expect(model).toContain("@@index([userId])");
  });

  it("keeps the row when the user is deleted, and refuses a negative row count", () => {
    expect(statements).toContain(
      'FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE',
    );
    expect(model).toMatch(/onDelete: SetNull/);
    expect(statements).toContain('CONSTRAINT "ImportBatch_rows_check" CHECK ("rows" >= 0)');
  });

  it("only adds: nothing is changed, deleted or written, and the audit log is not touched", () => {
    expect(statements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/m);
    expect(statements).not.toContain("AuditLog");
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(2);
    expect(statements.match(/ALTER TABLE "(?!ImportBatch")/g)).toBeNull();
  });
});

describe("open works migration", () => {
  const statements = openWorks
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const at = (text: string): number => statements.indexOf(text);
  const model = new RegExp(String.raw`model WorkItem \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("creates the four enums with the values the application uses, in the order a sort by them follows", () => {
    expect(statements).toContain(
      `CREATE TYPE "WorkPhase" AS ENUM ('FOUNDATION', 'STRUCTURE', 'MEP', 'FINISHING', 'EXTERNAL');`,
    );
    expect(statements).toContain(
      `CREATE TYPE "WorkStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DELAYED', 'DONE');`,
    );
    expect(statements).toContain(`CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');`);
    expect(statements).toContain(`CREATE TYPE "WorkItemSource" AS ENUM ('MANUAL', 'PHASE');`);
  });

  it("creates the table with a nullable creator (NULL is the system), a SMALLINT progress and a version at 1", () => {
    expect(statements).toContain('CREATE TABLE "WorkItem"');
    expect(statements).toContain('"createdById" TEXT,');
    expect(statements).not.toContain('"createdById" TEXT NOT NULL');
    expect(statements).toContain('"progress" SMALLINT NOT NULL DEFAULT 0,');
    expect(statements).toContain('"status" "WorkStatus" NOT NULL DEFAULT \'NOT_STARTED\',');
    expect(statements).toContain('"priority" "Priority" NOT NULL DEFAULT \'MEDIUM\',');
    expect(statements).toContain('"version" INTEGER NOT NULL DEFAULT 1,');
    expect(statements).toContain('"startDate" DATE,');
    expect(statements).toContain('"endDate" DATE,');
    expect(model).toMatch(/createdById\s+String\?/);
    expect(model).toMatch(/progress\s+Int\s+@default\(0\) @db\.SmallInt/);
  });

  it("deletes a villa's items with it, and refuses to delete a phase or a contractor that an item points at", () => {
    expect(statements).toContain(
      'ADD CONSTRAINT "WorkItem_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'ADD CONSTRAINT "WorkItem_elecPhaseId_fkey" FOREIGN KEY ("elecPhaseId") REFERENCES "ElecPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'ADD CONSTRAINT "WorkItem_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(statements).toContain(
      'ADD CONSTRAINT "WorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE',
    );
  });

  it("makes a second automatic item for a villa and phase impossible, with a partial unique index", () => {
    expect(statements).toContain(
      `CREATE UNIQUE INDEX "WorkItem_villa_phase_auto_key" ON "WorkItem"("villaId", "elecPhaseId") WHERE "source" = 'PHASE';`,
    );
  });

  it("indexes the title for search with pg_trgm, and the columns the list filters and sorts on", () => {
    expect(statements).toContain(
      'CREATE INDEX "WorkItem_title_trgm_idx" ON "WorkItem" USING GIN ("title" gin_trgm_ops);',
    );
    for (const index of [
      'CREATE INDEX "WorkItem_villaId_status_idx" ON "WorkItem"("villaId", "status");',
      'CREATE INDEX "WorkItem_status_idx" ON "WorkItem"("status");',
      'CREATE INDEX "WorkItem_endDate_idx" ON "WorkItem"("endDate");',
      'CREATE INDEX "WorkItem_contractorId_idx" ON "WorkItem"("contractorId");',
      'CREATE INDEX "WorkItem_elecPhaseId_idx" ON "WorkItem"("elecPhaseId");',
      'CREATE INDEX "WorkItem_createdById_idx" ON "WorkItem"("createdById");',
    ]) {
      expect(statements).toContain(index);
    }
    expect(model).toMatch(/@@index\(\[villaId, status\]\)/);
    expect(model).toMatch(/@@index\(\[endDate\]\)/);
  });

  it("checks the progress, the date order, the automatic item's phase, and that status and progress agree", () => {
    expect(statements).toContain('CONSTRAINT "WorkItem_progress_check" CHECK ("progress" BETWEEN 0 AND 100)');
    expect(statements).toContain(
      `CONSTRAINT "WorkItem_dates_check" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate")`,
    );
    expect(statements).toContain(
      `CONSTRAINT "WorkItem_phase_source_check" CHECK ("source" <> 'PHASE' OR "elecPhaseId" IS NOT NULL)`,
    );
    expect(statements).toContain(`(("status" = 'DONE') = ("progress" = 100))`);
    expect(statements).toContain(`("status" <> 'NOT_STARTED' OR "progress" = 0)`);
  });

  it("backfills an item for every progress above 0, after the table and its rules exist", () => {
    expect(statements).toContain('FROM "VillaPhaseProgress" p');
    expect(statements).toContain('WHERE p."progress" > 0');
    expect(at('CREATE TABLE "WorkItem"')).toBeLessThan(at("WorkItem_status_check"));
    expect(at("WorkItem_status_check")).toBeLessThan(at('INSERT INTO "WorkItem"'));
  });

  it("makes the backfilled items by the system: no creator, the villa's contractor, the progress row's day", () => {
    expect(statements).toMatch(/'PHASE', 1, NULL, now\(\), now\(\)/);
    expect(statements).toContain('v."contractorId", p."updatedAt"::date');
    expect(statements).toMatch(
      /CASE WHEN p\."progress" = 100 THEN 'DONE'::"WorkStatus" ELSE 'IN_PROGRESS'::"WorkStatus" END/,
    );
    expect(statements).toContain('JOIN "Villa" v ON v."id" = p."villaId"');
    expect(statements).toContain('JOIN "ElecPhase" ph ON ph."id" = p."elecPhaseId"');
  });

  it("appends one audit entry per backfilled item with no actor, and never changes or removes audit rows", () => {
    expect(statements).toContain(
      'INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "before", "after")',
    );
    expect(statements).toMatch(
      /gen_random_uuid\(\)::text, NULL, 'open_work\.auto_sync', 'WorkItem', c\."id", NULL,/,
    );
    expect(statements).not.toMatch(/UPDATE "AuditLog"|DELETE FROM "AuditLog"|TRUNCATE|DISABLE TRIGGER/i);
    expect(statements).not.toMatch(/DROP /);
  });

  it("touches no existing table other than appending audit rows", () => {
    expect(statements).not.toMatch(/ALTER TABLE "(Villa|ElecPhase|Contractor|User|VillaPhaseProgress)"/);
    expect(statements).not.toMatch(/UPDATE "(Villa|ElecPhase|Contractor|User|VillaPhaseProgress)"/);
  });
});

describe("daily report search indexes migration", () => {
  const statements = reportSearchIndexes
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  const model = new RegExp(String.raw`model DailyReport \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it.each([
    ["issues", "DailyReport_issues_trgm_idx"],
    ["preparedBy", "DailyReport_preparedBy_trgm_idx"],
  ])("adds the trigram index on %s that the search used (slice 14b)", (column, index) => {
    expect(statements).toContain(
      `CREATE INDEX "${index}" ON "DailyReport" USING GIN ("${column}" gin_trgm_ops);`,
    );
  });

  it("is followed by slice 19: the index on issues is renamed with the column and the schema declares the notes index; the preparedBy one goes with its column", () => {
    const slice19 = readFileSync(
      new URL("../../prisma/migrations/20261111090000_slice19_schema/migration.sql", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    expect(slice19).toContain(
      `ALTER INDEX "DailyReport_issues_trgm_idx" RENAME TO "DailyReport_notes_trgm_idx";`,
    );
    expect(model).toContain(
      `@@index([notes(ops: raw("gin_trgm_ops"))], type: Gin, map: "DailyReport_notes_trgm_idx")`,
    );
    expect(model).not.toContain("preparedBy_trgm_idx");
    expect(model).not.toContain("issues");
  });

  it("only adds: two indexes, no data touched, no other table", () => {
    expect(statements.match(/CREATE INDEX/g)).toHaveLength(2);
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|CREATE TABLE)\b/i);
    expect(statements.match(/ ON "([A-Za-z]+)"/g)).toEqual([' ON "DailyReport"', ' ON "DailyReport"']);
  });

  it("runs the way Prisma runs it, as one transaction, with nothing that would end it early", () => {
    expect(statements).not.toMatch(/\b(COMMIT|ROLLBACK|BEGIN)\b|CONCURRENTLY/i);
  });
});
