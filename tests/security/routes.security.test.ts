import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../modules/auth/in-memory-auth.repository.js";
import { code, doc, tables } from "../docs/source.js";

vi.mock("../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../modules/auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { createApp } from "../../src/app.js";
import { signAccessToken } from "../../src/core/security/jwt.js";
import { v1Router } from "../../src/routes/index.js";
import type { User } from "../../src/generated/prisma/client.js";

// Every route of the API, called for real: nobody gets past a route that needs a signed-in user without a valid access
// token, and a signed-in user without the route's permission is refused before anything is read or changed. The routes
// are read from the mounted routers, so a new route is checked the day it is added; a new public one has to be added to
// PUBLIC below on purpose.

const app = createApp();

// The only routes anyone may call without signing in (docs/api.md, Access "public").
const PUBLIC = new Set([
  "GET /health",
  "POST /auth/signup",
  "POST /auth/login",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  // A file for a valid signed link (?token=), checked below.
  "GET /villa-documents/:id/file",
]);

type Route = { method: string; path: string };
type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle: { stack?: Layer[] } };

function routesOf(): Route[] {
  const out: Route[] = [];
  const walk = (layers: Layer[]): void => {
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          out.push({ method: method.toUpperCase(), path: layer.route.path });
        }
      } else if (layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((v1Router as unknown as { stack: Layer[] }).stack);
  return out;
}

// A concrete URL for a route: a factory type where one is expected, else a fresh UUID for every parameter.
const urlOf = (path: string): string =>
  `/api/v1${path.replace(/:type\b/g, "SWITCHGEAR").replace(/:[A-Za-z]+/g, () => randomUUID())}`;

const keyOf = (route: Route): string => `${route.method} ${route.path}`;

// The access docs/api.md gives each route: a permission code, "signed in" or "public".
function documentedAccess(): Map<string, string> {
  const access = new Map<string, string>();
  for (const { table } of tables(doc("api.md"))) {
    if (table.header[0] !== "Method") continue;
    for (const row of table.rows)
      access.set(`${code(row[0] ?? "")} ${code(row[1] ?? "")}`, code(row[2] ?? ""));
  }
  return access;
}

const send = (route: Route, authorization?: string) => {
  const agent = request(app);
  const call = (agent as unknown as Record<string, (url: string) => request.Test>)[
    route.method.toLowerCase()
  ]!(urlOf(route.path));
  const withAuth = authorization ? call.set("Authorization", authorization) : call;
  return withAuth.set("Accept-Language", "en").set("Idempotency-Key", randomUUID()).send({});
};

const routes = routesOf();
const guarded = routes.filter((route) => !PUBLIC.has(keyOf(route)));

let employee: User;
beforeEach(() => {
  store.reset();
  employee = store.addUser({ name: "No Rights", email: `e${randomUUID()}@example.test`, passwordHash: "x" });
});

describe("every route of the API", () => {
  it("is found, and every public one is on the list on purpose", () => {
    expect(routes.length).toBeGreaterThan(150);
    const publicFound = routes.filter((route) => PUBLIC.has(keyOf(route))).map(keyOf);
    expect(publicFound.sort()).toEqual([...PUBLIC].sort());
  });

  it.each(guarded.map((route) => [keyOf(route), route] as const))(
    "%s refuses a caller without a token (401)",
    async (_key, route) => {
      expect((await send(route)).status).toBe(401);
    },
  );

  it.each(guarded.map((route) => [keyOf(route), route] as const))(
    "%s refuses a token signed with another secret (401)",
    async (_key, route) => {
      const forged = await new SignJWT({ role: "ADMIN" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(randomUUID())
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode("not-the-server-secret-but-long-enough-0123456789"));
      expect((await send(route, `Bearer ${forged}`)).status).toBe(401);
    },
  );

  const access = documentedAccess();
  const withPermission = guarded.filter((route) => {
    const value = access.get(keyOf(route));
    return value !== undefined && value !== "signed in" && value !== "public";
  });

  it("has a documented permission for most guarded routes", () => {
    expect(withPermission.length).toBeGreaterThan(100);
  });

  it.each(withPermission.map((route) => [keyOf(route), access.get(keyOf(route)), route] as const))(
    "%s refuses a signed-in user without %s (403)",
    async (_key, _permission, route) => {
      const token = await signAccessToken({ id: employee.id, role: employee.role });
      expect((await send(route, `Bearer ${token}`)).status).toBe(403);
    },
  );
});

describe("the signed document link", () => {
  it("gives nothing without a valid token", async () => {
    const url = `/api/v1/villa-documents/${randomUUID()}/file`;
    expect((await request(app).get(url)).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).get(`${url}?token=forged`)).status).toBeGreaterThanOrEqual(400);
  });
});
