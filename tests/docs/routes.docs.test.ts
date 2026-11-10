import { describe, expect, it, vi } from "vitest";
import { collectRoutes, type RouteInfo } from "./introspect.js";
import { code, doc, tables } from "./source.js";

// docs/api.md lists every route of the API: the method and path, who may call it, and whether it takes an Idempotency-Key or an
// If-Match. The routers are read as they are mounted, with the middleware factories swapped for ones that say what they were
// given, so nothing in the application changes for this test.

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

type Documented = { method: string; path: string; access: string; idempotency: string; ifMatch: string };

const accessOf = (route: RouteInfo): string => route.permission ?? (route.auth ? "signed in" : "public");
const keyOf = (route: { method: string; path: string }): string => `${route.method} ${route.path}`;

function documented(): Documented[] {
  const rows: Documented[] = [];
  for (const { table } of tables(doc("api.md"))) {
    if (table.header[0] !== "Method") continue;
    for (const row of table.rows) {
      rows.push({
        method: code(row[0] ?? ""),
        path: code(row[1] ?? ""),
        access: code(row[2] ?? ""),
        idempotency: code(row[3] ?? ""),
        ifMatch: code(row[4] ?? ""),
      });
    }
  }
  return rows;
}

describe("docs/api.md", async () => {
  const { v1Router } = await import("../../src/routes/index.js");
  const routes = collectRoutes(v1Router);
  const docs = documented();

  it("finds the routes (the check is not empty)", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(docs.length).toBeGreaterThan(100);
  });

  it("lists every route of the API, once", () => {
    const seen = new Set<string>();
    for (const row of docs) {
      expect(seen.has(keyOf(row)), `${keyOf(row)} is listed twice`).toBe(false);
      seen.add(keyOf(row));
    }
    expect(routes.map(keyOf).filter((key) => !seen.has(key))).toEqual([]);
  });

  it("lists no route the API does not have", () => {
    const real = new Set(routes.map(keyOf));
    expect(docs.map(keyOf).filter((key) => !real.has(key))).toEqual([]);
  });

  it("says who may call each route: a permission, any signed-in user, or anyone", () => {
    for (const row of docs) {
      const route = routes.find((candidate) => keyOf(candidate) === keyOf(row));
      expect(row.access, keyOf(row)).toBe(route ? accessOf(route) : "no such route");
    }
  });

  it("says whether each route takes an Idempotency-Key (optional or required) and an If-Match", () => {
    for (const row of docs) {
      const route = routes.find((candidate) => keyOf(candidate) === keyOf(row));
      expect(row.idempotency, `${keyOf(row)} Idempotency-Key`).toBe(route?.idempotency ?? "—");
      expect(row.ifMatch, `${keyOf(row)} If-Match`).toBe(route?.ifMatch ?? "—");
    }
  });

  it("puts a permission only on routes that sign the caller in first", () => {
    for (const route of routes) {
      if (route.permission !== undefined) expect(route.auth, keyOf(route)).toBe(true);
    }
  });

  it("is where write-safety.md says the keys are required: the imports, and only them", () => {
    const required = routes.filter((route) => route.idempotency === "required").map(keyOf);
    expect(required.sort()).toEqual(
      [
        "contractors",
        "daily-labour",
        "daily-reports",
        "material-deliveries",
        "open-works",
        "site-reports",
        "small-works",
        "villas",
      ]
        .map((name) => `POST /${name}/import`)
        .sort(),
    );
    expect(routes.some((route) => route.ifMatch === "required")).toBe(false);
  });
});
