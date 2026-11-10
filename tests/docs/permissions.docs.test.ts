import { describe, expect, it, vi } from "vitest";
import { PERMISSION_CODES } from "../../src/shared/constants/permissions.js";
import { collectRoutes } from "./introspect.js";
import { code, codes, doc, tables } from "./source.js";

// docs/permissions.md lists every permission code, the routes each one opens, and what each dashboard card needs.

vi.mock("../../src/core/database/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/core/middleware/auth.js", async () => ({
  auth: (await import("./introspect.js")).fakes.auth(),
}));
vi.mock("../../src/core/middleware/requirePermission.js", async () => ({
  requirePermission: (await import("./introspect.js")).fakes.requirePermission,
}));
vi.mock("../../src/core/middleware/validate.js", async () => ({
  validate: (await import("./introspect.js")).fakes.validate,
}));
vi.mock("../../src/core/idempotency/index.js", async (importActual) => ({
  ...(await importActual<object>()),
  idempotent: (await import("./introspect.js")).fakes.idempotent,
}));
vi.mock("../../src/core/concurrency/version.js", async (importActual) => ({
  ...(await importActual<object>()),
  ifMatch: (await import("./introspect.js")).fakes.ifMatch,
}));

describe("docs/permissions.md", async () => {
  const { v1Router } = await import("../../src/routes/index.js");
  const { CARD_PERMISSIONS } = await import("../../src/modules/dashboard/dto/dashboard.dto.js");
  const routes = collectRoutes(v1Router);

  const opened = new Map<string, string[]>();
  for (const { table } of tables(doc("permissions.md"))) {
    if (table.header[0] !== "Permission") continue;
    for (const row of table.rows) {
      opened.set(code(row[0] ?? ""), codes(row[1] ?? "").sort());
    }
  }

  it("lists every permission code, once", () => {
    expect(PERMISSION_CODES.filter((permission) => !opened.has(permission))).toEqual([]);
    expect(
      [...opened.keys()].filter((permission) => !PERMISSION_CODES.includes(permission as never)),
    ).toEqual([]);
  });

  it("names the routes each permission opens, exactly", () => {
    for (const permission of PERMISSION_CODES) {
      const real = routes
        .filter((route) => route.permission === permission)
        .map((route) => `${route.method} ${route.path}`)
        .sort();
      expect(opened.get(permission), permission).toEqual(real);
    }
  });

  it("has no route behind a permission that is not a known code", () => {
    for (const route of routes) {
      if (route.permission !== undefined) {
        expect(PERMISSION_CODES, `${route.method} ${route.path}`).toContain(route.permission);
      }
    }
  });

  it("lists the permissions each dashboard card needs", () => {
    const cards = new Map<string, string[]>();
    for (const { table } of tables(doc("permissions.md"))) {
      if (table.header[0] !== "Card") continue;
      for (const row of table.rows) cards.set(code(row[0] ?? ""), codes(row[1] ?? "").sort());
    }
    expect([...cards.keys()].sort()).toEqual(Object.keys(CARD_PERMISSIONS).sort());
    for (const [card, needs] of Object.entries(CARD_PERMISSIONS)) {
      expect(cards.get(card), card).toEqual([...needs].sort());
    }
  });
});
