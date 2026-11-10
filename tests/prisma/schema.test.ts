import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSIONED_TABLES } from "../../src/core/concurrency/version.js";
import { ElecPhaseStatus, PartyStatus, Prisma, Role } from "../../src/generated/prisma/client.js";

// Line endings are read as \n: a Windows checkout (core.autocrlf) turns them into \r\n.
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("generated Prisma client", () => {
  it("exposes exactly the 30 approved models", () => {
    expect(Object.values(Prisma.ModelName).sort()).toEqual(
      [
        "Area",
        "AuditLog",
        "CivilEngineer",
        "Contractor",
        "DailyLabour",
        "DailyReport",
        "DailySmallWork",
        "ElecPhase",
        "ElectricalEngineer",
        "Factory",
        "IdempotencyKey",
        "ImportBatch",
        "MaintenanceVilla",
        "MaterialDelivery",
        "MaterialDeliveryLine",
        "MaterialDeliveryNote",
        "MaterialItem",
        "Notification",
        "NotificationRecipient",
        "PasswordResetToken",
        "Permission",
        "SiteReport",
        "Villa",
        "WorkItem",
        "VillaDocument",
        "VillaMaterialRequirement",
        "VillaPhaseProgress",
        "RefreshToken",
        "User",
        "UserPermission",
      ].sort(),
    );
  });

  it("exposes the Role enum, and no villa status enum any more", async () => {
    expect(Object.values(Role)).toEqual(["ADMIN", "EMPLOYEE"]);
    const client = await import("../../src/generated/prisma/client.js");
    expect(client).not.toHaveProperty("VillaStatus");
  });

  it("exposes the ElecPhaseStatus enum", () => {
    expect(Object.values(ElecPhaseStatus)).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("exposes the PartyStatus enum", () => {
    expect(Object.values(PartyStatus)).toEqual(["ACTIVE", "INACTIVE"]);
  });
});

describe.each(["CivilEngineer", "ElectricalEngineer", "Contractor"])("%s email and status", (name) => {
  const model = new RegExp(String.raw`model ${name} \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("has an optional email that is not unique, and a status that starts ACTIVE", () => {
    expect(model).toMatch(/email\s+String\?\n/);
    expect(model).not.toMatch(/email\s+String\?\s+@unique/);
    expect(model).not.toMatch(/@@unique\([^)]*email/);
    expect(model).toMatch(/status\s+PartyStatus\s+@default\(ACTIVE\)/);
  });

  it("keeps the version column the write safety relies on", () => {
    expect(model).toMatch(/version\s+Int\s+@default\(1\)/);
  });
});

describe("schema.prisma rules", () => {
  const block = (name: string): string => {
    const match = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema);
    if (!match) {
      throw new Error(`model ${name} not found`);
    }
    return match[0];
  };

  it("keeps new users inactive until activated", () => {
    expect(block("User")).toMatch(/isActive\s+Boolean\s+@default\(false\)/);
  });

  it("gives Villa its uniqueness and indexes, with a villa number, a plot and no status or flags", () => {
    const villa = block("Villa");
    expect(villa).toMatch(/villaNumber\s+String\s+@unique/);
    expect(villa).toMatch(/plot\s+String\n/);
    expect(villa).toMatch(/@@unique\(\[areaId, block, plot\]\)/);
    expect(villa).toMatch(/@@index\(\[civilEngineerId\]\)/);
    expect(villa).toMatch(/@@index\(\[areaId\]\)/);
    expect(villa).toMatch(/@@index\(\[contractorId\]\)/);
    expect(villa).toMatch(/onDelete: Restrict/);
    for (const gone of ["status", "materialRequested", "checklistCompleted", "projectNumber", "plotNumber"]) {
      expect(villa).not.toMatch(new RegExp(String.raw`\n\s+${gone}\s`));
    }
  });

  it("gives a villa one optional contractor that cannot be deleted while it has villas", () => {
    const villa = block("Villa");
    expect(villa).toMatch(/contractorId\s+String\?\n/);
    expect(villa).toMatch(
      /contractor\s+Contractor\?\s+@relation\(fields: \[contractorId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it("keeps a villa's documents with the villa and with no link to an activity", () => {
    const document = block("VillaDocument");
    expect(document).toMatch(/villaId\s+String\n/);
    expect(document).toMatch(/onDelete: Cascade/);
    expect(document).toMatch(/storageKey\s+String\s+@unique/);
    expect(document).not.toMatch(/activity/i);
  });

  it("has no activity or contractor-link model and no leftover project names", () => {
    expect(schema).not.toMatch(/model VillaActivity|model VillaContractor|model Project/);
    expect(schema).not.toMatch(/ProjectStatus|VillaStatus|ActivityPosition/);
    expect(schema).not.toMatch(/project/i);
  });

  it("declares the ten trigram GIN indexes in the schema so migrate dev sees no drift", () => {
    const declared = [...schema.matchAll(/map: "([A-Za-z]+_[A-Za-z]+_trgm_idx)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(
      [
        "CivilEngineer_name_trgm_idx",
        "Contractor_name_trgm_idx",
        "DailyReport_notes_trgm_idx",
        "DailySmallWork_description_trgm_idx",
        "ElectricalEngineer_name_trgm_idx",
        "SiteReport_title_trgm_idx",
        "Villa_block_trgm_idx",
        "Villa_ownerName_trgm_idx",
        "Villa_plot_trgm_idx",
        "Villa_villaNumber_trgm_idx",
      ].sort(),
    );
    expect(schema.match(/type: Gin/g)).toHaveLength(10);
  });

  it("lets audit rows outlive their actor", () => {
    expect(block("AuditLog")).toMatch(/onDelete: SetNull/);
  });
});

describe("Area model", () => {
  const model = /model Area \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  const villa = /model Villa \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";

  it("has a name, a city and a version, and no stored count of villas", () => {
    expect(model).toMatch(/name\s+String\n/);
    expect(model).toMatch(/city\s+String\n/);
    expect(model).toMatch(/version\s+Int\s+@default\(1\)/);
    expect(model).not.toMatch(/count/i);
  });

  it("says where the unique name and city live, since Prisma cannot declare it", () => {
    expect(schema).toContain("Area_name_city_lower_key");
    expect(model).not.toMatch(/@unique|@@unique/);
  });

  it("is required on a villa and cannot be deleted while a villa points at it", () => {
    expect(villa).toMatch(/areaId\s+String\n/);
    expect(villa).toMatch(
      /area\s+Area\s+@relation\(fields: \[areaId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it("no longer keeps the area as text on a villa", () => {
    expect(villa).not.toMatch(/\n\s+area\s+String/);
    expect(schema).not.toContain("Villa_area_trgm_idx");
  });
});

describe("ElecPhase model", () => {
  const model = /model ElecPhase \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";

  it("is a table of phases with an order, a status that starts ACTIVE and a version", () => {
    expect(model).toMatch(/sortOrder\s+Int\n/);
    expect(model).toMatch(/status\s+ElecPhaseStatus\s+@default\(ACTIVE\)/);
    expect(model).toMatch(/version\s+Int\s+@default\(1\)/);
    expect(model).toMatch(/@@index\(\[sortOrder\]\)/);
  });

  it("says where the unique name lives, since Prisma cannot declare it", () => {
    expect(schema).toContain("ElecPhase_name_lower_key");
    expect(model).not.toMatch(/@unique|@@unique/);
  });
});

describe("VillaPhaseProgress model", () => {
  const model = new RegExp(String.raw`model VillaPhaseProgress \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("has one row per villa and phase: a composite key, a 0..100 progress, a completion time and a version", () => {
    expect(model).toMatch(/@@id\(\[villaId, elecPhaseId\]\)/);
    expect(model).toMatch(/progress\s+Int\s+@default\(0\)\s+@db\.SmallInt/);
    expect(model).toMatch(/completedAt\s+DateTime\?/);
    expect(model).toMatch(/version\s+Int\s+@default\(1\)/);
    expect(model).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
  });

  it("goes with its villa but cannot outlive a phase that has progress", () => {
    expect(model).toMatch(
      /villa\s+Villa\s+@relation\(fields: \[villaId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(model).toMatch(
      /elecPhase\s+ElecPhase\s+@relation\(fields: \[elecPhaseId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it("keeps no stored overall progress on a villa (it is derived on read)", () => {
    const villaModel = new RegExp(String.raw`model Villa \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";
    expect(villaModel).not.toMatch(new RegExp(String.raw`\n\s+progress\s`));
  });
});

describe("Villa ready for inspection", () => {
  const villa = new RegExp(String.raw`model Villa \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";
  const user = new RegExp(String.raw`model User \{[\s\S]*?\n\}`).exec(schema)?.[0] ?? "";

  it("is gone: the villa has no ready column and the user no relation for it", () => {
    expect(villa).not.toMatch(/ready/i);
    expect(user).not.toMatch(/inspectedVillas|VillaInspectionMarker/);
  });
});

describe("versioned tables", () => {
  // VillaPhaseProgress has a version too, but no id column (its key is the villa and the phase), so lockVersion cannot
  // lock it: the progress update locks that row itself (FOR UPDATE).
  it("lists exactly the models that carry an id and a version column, so If-Match can lock each of them", () => {
    const hasVersion = new RegExp(String.raw`\n\s+version\s+Int\s+@default\(1\)`);
    const hasId = new RegExp(String.raw`\n\s+id\s+String\s+@id`);
    const withVersion = [...schema.matchAll(new RegExp(String.raw`model (\w+) \{([\s\S]*?)\n\}`, "g"))]
      .filter(([, , body]) => hasVersion.test(body ?? "") && hasId.test(body ?? ""))
      .map(([, name]) => name)
      .sort();

    expect([...VERSIONED_TABLES].sort()).toEqual(withVersion);
    expect(withVersion).toContain("Area");
    expect(withVersion).not.toContain("VillaPhaseProgress");
  });
});
