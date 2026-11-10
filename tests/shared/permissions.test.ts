import { describe, expect, it } from "vitest";
import { PERMISSION_CODES, PERMISSIONS } from "../../src/shared/constants/permissions.js";

const EXPECTED_CODES = [
  "villas:read",
  "villas:detail",
  "villas:create",
  "villas:update",
  "villas:delete",
  "villas:export",
  "villas:progress",
  "villas:inspection",
  "villas:import",
  "open-works:read",
  "open-works:create",
  "open-works:update",
  "open-works:delete",
  "open-works:export",
  "open-works:import",
  "daily-reports:read",
  "daily-reports:create",
  "daily-reports:update",
  "daily-reports:delete",
  "daily-reports:export",
  "daily-reports:import",
  "small-works:read",
  "small-works:create",
  "small-works:update",
  "small-works:delete",
  "small-works:export",
  "small-works:import",
  "site-reports:read",
  "site-reports:create",
  "site-reports:update",
  "site-reports:delete",
  "site-reports:export",
  "site-reports:import",
  "daily-labour:read",
  "daily-labour:create",
  "daily-labour:update",
  "daily-labour:delete",
  "daily-labour:export",
  "daily-labour:import",
  "civil-engineers:read",
  "civil-engineers:create",
  "civil-engineers:update",
  "civil-engineers:delete",
  "areas:read",
  "areas:create",
  "areas:update",
  "areas:delete",
  "elec-phases:read",
  "elec-phases:create",
  "elec-phases:update",
  "elec-phases:delete",
  "electrical-engineers:read",
  "electrical-engineers:create",
  "electrical-engineers:update",
  "electrical-engineers:delete",
  "contractors:read",
  "contractors:create",
  "contractors:update",
  "contractors:delete",
  "contractors:summary",
  "contractors:import",
  "maintenance:read",
  "maintenance:create",
  "maintenance:update",
  "maintenance:delete",
  "materials:read",
  "materials:create",
  "materials:update",
  "materials:delete",
  "villa-documents:upload",
  "villa-documents:download",
  "villa-documents:delete",
  "users:read",
  "users:create",
  "users:update",
  "users:deactivate",
  "users:delete",
  "permissions:assign",
  "audit:read",
  "dashboard:read",
];

describe("permission codes", () => {
  it("are exactly the approved list", () => {
    expect([...PERMISSION_CODES].sort()).toEqual([...EXPECTED_CODES].sort());
    expect(PERMISSION_CODES).toHaveLength(80);
  });

  it("are unique and shaped resource:action", () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
    for (const code of PERMISSION_CODES) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*:[a-z]+$/);
    }
  });

  it("have constant names that match their codes", () => {
    for (const [name, code] of Object.entries(PERMISSIONS)) {
      expect(name).toBe(code.replace(/[:-]/g, "_").toUpperCase());
    }
  });
});
